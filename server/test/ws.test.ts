import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEvents, emptyState, conversationMessages, type ServerFrame } from "@assistant/protocol";
import { MockProvider } from "../src/providers/mock.js";
import { Client, register, startApp, until } from "./helpers.js";

type Started = Awaited<ReturnType<typeof startApp>>;
let s: Started;
beforeAll(async () => { s = await startApp({ provider: new MockProvider(8), cfg: { DEVICE_ACTION_TIMEOUT_MS: 3000 } }); });
afterAll(async () => { await s.close(); });

describe("websocket sync", () => {
  it("rejects bad tokens", async () => {
    const res = await fetch(`${s.url}/me`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("two devices of one user see the same live stream; a late device resumes from its cursor", async () => {
    const web = await register(s.url, "Chrome", "web");
    const codeRes = await fetch(`${s.url}/auth/pair-code`, { method: "POST", headers: { authorization: `Bearer ${web.token}` } });
    const { code } = (await codeRes.json()) as { code: string };
    const phone = await register(s.url, "Pixel", "android", code);
    expect(phone.userId).toBe(web.userId);

    const a = await Client.connect(s.wsUrl, web.token);
    const b = await Client.connect(s.wsUrl, phone.token);
    const welcome = a.frames.find((f) => f.type === "welcome") as Extract<ServerFrame, { type: "welcome" }>;
    expect(welcome.deviceId).toBe(web.deviceId);
    await b.waitFor((f) => f.type === "presence" && f.devices.filter((d) => d.online).length === 2);

    a.send({ type: "send", clientMsgId: "k1", text: "What is 12 * 12?" });
    const ack = await a.waitFor<Extract<ServerFrame, { type: "ack" }>>((f) => f.type === "ack");
    expect(ack.clientMsgId).toBe("k1");
    // the phone sees the user's message and the streaming assistant message as it happens
    await b.waitFor((f) => f.type === "event" && f.event.body.type === "message.delta");
    const seqSoFar = b.events().at(-1)!.seq;
    // third device connects mid-stream with the phone's cursor
    const c = await Client.connect(s.wsUrl, phone.token, seqSoFar);
    await a.waitFor((f) => f.type === "event" && f.event.body.type === "message.completed");
    await b.waitFor((f) => f.type === "event" && f.event.body.type === "message.completed");
    await c.waitFor((f) => f.type === "event" && f.event.body.type === "message.completed");

    const stateA = applyEvents(emptyState(), a.events());
    const stateB = applyEvents(emptyState(), b.events());
    expect(stateB).toEqual(stateA);
    // c has only events > seqSoFar, but folding them onto b's partial state yields the same final state
    const partial = applyEvents(emptyState(), b.events().filter((e) => e.seq <= seqSoFar));
    expect(applyEvents(partial, c.events())).toEqual(stateA);
    expect(c.events().every((e) => e.seq > seqSoFar)).toBe(true);
    expect(new Set(a.events().map((e) => e.seq)).size).toBe(a.events().length); // no duplicates

    const msgs = conversationMessages(stateA, ack.conversationId);
    expect(msgs[0]).toMatchObject({ role: "user", content: "What is 12 * 12?", deviceId: web.deviceId });
    expect(msgs[1]!.toolCalls?.[0]).toMatchObject({ name: "calculate" });
    expect(msgs[1]!.content).toContain("144");

    // REST sync and snapshot agree with the websocket view
    const sync = (await (await fetch(`${s.url}/sync?since=0`, { headers: { authorization: `Bearer ${phone.token}` } })).json()) as { events: unknown[]; seq: number };
    expect(sync.seq).toBe(stateA.seq);
    expect(applyEvents(emptyState(), sync.events as never)).toEqual(stateA);
    const snap = (await (await fetch(`${s.url}/snapshot`, { headers: { authorization: `Bearer ${phone.token}` } })).json()) as { messages: Array<{ content: string }>; seq: number };
    expect(snap.messages[1]!.content).toBe(msgs[1]!.content);
    a.close(); b.close(); c.close();
  });

  it("device actions are fulfilled by the device that answers first", async () => {
    const web = await register(s.url, "Chrome", "web");
    const code = ((await (await fetch(`${s.url}/auth/pair-code`, { method: "POST", headers: { authorization: `Bearer ${web.token}` } })).json()) as { code: string }).code;
    const phone = await register(s.url, "Pixel", "android", code);
    const a = await Client.connect(s.wsUrl, web.token);
    const b = await Client.connect(s.wsUrl, phone.token);
    a.send({ type: "send", clientMsgId: "k2", text: "set an alarm for 7am" });
    const actionFrame = await b.waitFor<Extract<ServerFrame, { type: "event" }>>((f) => f.type === "event" && f.event.body.type === "device.action");
    const action = (actionFrame.event.body as Extract<typeof actionFrame.event.body, { type: "device.action" }>).action;
    expect(action.name).toBe("set_alarm");
    b.send({ type: "device.result", actionId: action.id, ok: true, result: { scheduled: true } });
    await a.waitFor((f) => f.type === "event" && f.event.body.type === "message.completed");
    const done = a.events().find((e) => e.body.type === "device.action.done")!.body as { deviceId: string; ok: boolean };
    expect(done).toMatchObject({ deviceId: phone.deviceId, ok: true });
    // a second result for the same action is rejected
    a.send({ type: "device.result", actionId: action.id, ok: true, result: {} });
    await a.waitFor((f) => f.type === "error" && f.code === "unknown_action");
    a.close(); b.close();
  });

  it("cancel stops the stream and the message is marked cancelled for every device", async () => {
    const web = await register(s.url, "Chrome", "web");
    const a = await Client.connect(s.wsUrl, web.token);
    a.send({ type: "send", clientMsgId: "k3", text: "tell me a very long story" });
    const ack = await a.waitFor<Extract<ServerFrame, { type: "ack" }>>((f) => f.type === "ack");
    await a.waitFor((f) => f.type === "event" && f.event.body.type === "message.delta");
    a.send({ type: "cancel", conversationId: ack.conversationId });
    const completed = await a.waitFor<Extract<ServerFrame, { type: "event" }>>((f) => f.type === "event" && f.event.body.type === "message.completed");
    expect(completed.event.body).toMatchObject({ status: "cancelled" });
    a.close();
  });

  it("REST send + idempotent retry; invalid frames produce typed errors", async () => {
    const web = await register(s.url, "CLI", "cli");
    const h = { authorization: `Bearer ${web.token}`, "content-type": "application/json" };
    const r1 = (await (await fetch(`${s.url}/conversations/new/messages`, { method: "POST", headers: h, body: JSON.stringify({ clientMsgId: "r1", text: "hi" }) })).json()) as { conversationId: string; deduplicated: boolean };
    const r2 = (await (await fetch(`${s.url}/conversations/new/messages`, { method: "POST", headers: h, body: JSON.stringify({ clientMsgId: "r1", text: "hi" }) })).json()) as { conversationId: string; deduplicated: boolean };
    expect(r2.deduplicated).toBe(true);
    expect(r2.conversationId).toBe(r1.conversationId);
    await until(() => s.app.ctx.events.messagesFor(web.userId, r1.conversationId).at(-1)?.status === "complete");
    const a = await Client.connect(s.wsUrl, web.token);
    a.send({ type: "bogus" });
    await a.waitFor((f) => f.type === "error" && f.code === "bad_frame");
    a.close();
  });
});
