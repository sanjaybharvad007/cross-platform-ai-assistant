/** Fastify app factory: REST + WebSocket, wired to the event store and the agent runner. */
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { PairCodeResponse, RegisterDeviceRequest, RegisterDeviceResponse, SnapshotResponse, SyncResponse, parse } from "@assistant/protocol";
import { AgentRunner } from "./agent/runner.js";
import { Auth, AuthError, type Identity } from "./auth.js";
import type { Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { EventStore } from "./events.js";
import { createProvider, type Provider } from "./providers/index.js";
import { DeviceBroker } from "./tools/device-broker.js";
import { handleSocket, Presence } from "./ws.js";

export interface AppOptions { cfg: Config; db?: Db; provider?: Provider; fetch?: typeof fetch; now?: () => number }

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp(opts: AppOptions) {
  const { cfg } = opts;
  const db = opts.db ?? openDb(cfg.DATABASE_PATH);
  const events = new EventStore(db);
  const auth = new Auth(db, cfg.JWT_SECRET);
  const broker = new DeviceBroker();
  const provider = opts.provider ?? createProvider(cfg);
  const runner = new AgentRunner({ db, events, provider, broker, cfg, fetch: opts.fetch, now: opts.now });
  const presence = new Presence();

  const app = Fastify({ logger: { level: cfg.LOG_LEVEL, transport: process.env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined } });
  await app.register(cors, { origin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(",") });
  await app.register(rateLimit, { max: cfg.RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  if (cfg.STATIC_DIR && existsSync(cfg.STATIC_DIR)) {
    await app.register(fastifyStatic, { root: resolve(cfg.STATIC_DIR), wildcard: false });
    app.setNotFoundHandler((req, reply) => (req.method === "GET" && !req.url.startsWith("/api") && req.headers.accept?.includes("text/html") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" })));
  }

  const identity = async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : (req.query as { token?: string }).token;
    if (!token) throw new AuthError("missing token");
    return auth.verify(token);
  };
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AuthError) return reply.code(401).send({ error: err.message });
    if (err instanceof z.ZodError || err.name === "ProtocolError") return reply.code(400).send({ error: err.message });
    if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({ ok: true, provider: provider.id, pendingDeviceActions: broker.size }));
  app.post("/auth/device", async (req) => {
    const body = parse(RegisterDeviceRequest, req.body);
    const r = await auth.registerDevice(body.name, body.platform, body.pairCode);
    return parse(RegisterDeviceResponse, r);
  });
  app.post("/auth/pair-code", async (req) => parse(PairCodeResponse, auth.createPairCode((await identity(req)).userId)));
  app.get("/me", async (req) => { const id = await identity(req); return { ...id, devices: auth.devices(id.userId, presence.devices(id.userId)) }; });
  app.get("/sync", async (req) => {
    const id = await identity(req);
    const since = Number((req.query as { since?: string }).since ?? 0);
    const page = events.since(id.userId, Number.isFinite(since) ? since : 0, 1000);
    return parse(SyncResponse, { events: page.events, seq: page.events.at(-1)?.seq ?? since, hasMore: page.hasMore });
  });
  app.get("/snapshot", async (req) => { const id = await identity(req); return parse(SnapshotResponse, { ...events.snapshot(id.userId), devices: auth.devices(id.userId, presence.devices(id.userId)) }); });
  app.post("/conversations/:id/messages", async (req, reply) => {
    const id = await identity(req);
    const body = z.object({ clientMsgId: z.string(), text: z.string().min(1) }).parse(req.body);
    const convId = (req.params as { id: string }).id;
    const r = runner.send({ userId: id.userId, deviceId: id.deviceId, conversationId: convId === "new" ? undefined : convId, clientMsgId: body.clientMsgId, text: body.text });
    return reply.code(202).send({ conversationId: r.conversationId, userMessageId: r.userMessageId, assistantMessageId: r.assistantMessageId, deduplicated: r.deduplicated });
  });
  app.post("/conversations/:id/cancel", async (req) => { await identity(req); return { cancelled: runner.cancel((req.params as { id: string }).id) }; });
  app.patch("/conversations/:id", async (req) => {
    const id = await identity(req);
    const patch = z.object({ title: z.string().min(1).max(120).optional(), archived: z.boolean().optional() }).parse(req.body);
    events.append(id.userId, { type: "conversation.updated", conversationId: (req.params as { id: string }).id, patch: { ...patch, updatedAt: Date.now() } });
    return { ok: true };
  });
  app.delete("/conversations/:id", async (req) => { const id = await identity(req); events.append(id.userId, { type: "conversation.deleted", conversationId: (req.params as { id: string }).id }); return { ok: true }; });

  // Authenticate during the HTTP upgrade (preValidation) so the socket handler is synchronous:
  // a client's first frame can arrive before an awaited handler attaches its listener.
  app.get("/ws", { websocket: true, preValidation: async (req, reply) => {
    try { (req as FastifyRequest & { identity?: Identity }).identity = await identity(req); } catch (e) { await reply.code(401).send({ error: (e as Error).message }); }
  } }, (socket, req) => {
    const id = (req as FastifyRequest & { identity?: Identity }).identity!;
    handleSocket(socket, id, { auth, events, runner, broker, log: app.log }, presence);
  });

  return Object.assign(app, { ctx: { db, events, runner, auth, broker, presence } });
}
