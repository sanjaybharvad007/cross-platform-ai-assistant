import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { MockProvider } from "../src/providers/mock.js";
import type { Provider } from "../src/providers/types.js";
import type { ServerFrame } from "@assistant/protocol";

export function testConfig(over: Partial<Config> = {}): Config {
  return { ...loadConfig({ DATABASE_PATH: ":memory:", LLM_PROVIDER: "mock", LOG_LEVEL: "silent", DEVICE_ACTION_TIMEOUT_MS: "1500", RATE_LIMIT_PER_MINUTE: "10000" }), ...over };
}

export async function startApp(opts: { provider?: Provider; cfg?: Partial<Config>; fetch?: typeof fetch } = {}) {
  const app = await buildApp({ cfg: testConfig(opts.cfg), db: openDb(":memory:"), provider: opts.provider ?? new MockProvider(), fetch: opts.fetch });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;
  return { app, url, wsUrl: url.replace("http", "ws") + "/ws", close: () => app.close() };
}

export async function register(url: string, name = "test device", platform = "web", pairCode?: string) {
  const res = await fetch(`${url}/auth/device`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, platform, pairCode }) });
  return (await res.json()) as { token: string; userId: string; deviceId: string };
}

/** A tiny WS client that records every frame and lets tests await specific ones. */
export class Client {
  frames: ServerFrame[] = [];
  private waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];
  ws!: WebSocket;
  static async connect(wsUrl: string, token: string, since = 0): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`${wsUrl}?token=${token}`);
    c.ws.on("message", (raw) => { const f = JSON.parse(String(raw)) as ServerFrame; c.frames.push(f); c.waiters = c.waiters.filter((w) => { if (w.pred(f)) { w.resolve(f); return false; } return true; }); });
    await new Promise<void>((res, rej) => { c.ws.once("open", () => res()); c.ws.once("error", rej); });
    c.send({ type: "hello", since, protocol: 1 });
    await c.waitFor((f) => f.type === "synced");
    return c;
  }
  send(frame: unknown) { this.ws.send(JSON.stringify(frame)); }
  waitFor<T extends ServerFrame>(pred: (f: ServerFrame) => boolean, timeoutMs = 8000): Promise<T> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for frame; got ${this.frames.map((f) => f.type + (f.type === "event" ? ":" + f.event.body.type : "")).join(",")}`)), timeoutMs);
      this.waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f as T); } });
    });
  }
  events() { return this.frames.filter((f): f is Extract<ServerFrame, { type: "event" }> => f.type === "event").map((f) => f.event); }
  close() { this.ws.close(); }
}

export const until = async (pred: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("until: timeout"); await new Promise((r) => setTimeout(r, 10)); } };
