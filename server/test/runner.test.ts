import { describe, expect, it } from "vitest";
import { applyEvents, conversationMessages, emptyState } from "@assistant/protocol";
import { AgentRunner } from "../src/agent/runner.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/events.js";
import { MockProvider } from "../src/providers/mock.js";
import { DeviceBroker } from "../src/tools/device-broker.js";
import { testConfig } from "./helpers.js";

function setup(provider = new MockProvider()) {
  const db = openDb(":memory:");
  const events = new EventStore(db);
  const broker = new DeviceBroker();
  const runner = new AgentRunner({ db, events, provider, broker, cfg: testConfig({ DEVICE_ACTION_TIMEOUT_MS: 300 }) });
  return { db, events, broker, runner };
}

describe("agent runner", () => {
  it("creates the conversation, streams the answer and completes; the event log replays to the same state", async () => {
    const { events, runner } = setup();
    const r = runner.send({ userId: "u", deviceId: "web", clientMsgId: "c1", text: "hello there" });
    expect(r.deduplicated).toBe(false);
    await r.done;
    const log = events.since("u", 0).events;
    expect(log.map((e) => e.body.type)).toEqual(["conversation.created", "message.created", "message.created", ...Array(log.length - 4).fill("message.delta"), "message.completed"]);
    const state = applyEvents(emptyState(), log);
    const msgs = conversationMessages(state, r.conversationId);
    expect(msgs[1]!.content).toContain('You said: "hello there"');
    expect(msgs[1]!.status).toBe("complete");
    expect(state.conversations[r.conversationId]!.title).toBe("hello there");
    // SQL projection agrees with the folded log
    expect(events.messagesFor("u", r.conversationId)[1]!.content).toBe(msgs[1]!.content);
  });

  it("runs server tools and reports progress; the second turn keeps history", async () => {
    const { events, runner } = setup();
    const r = runner.send({ userId: "u", deviceId: "web", clientMsgId: "c1", text: "remind me to buy milk" });
    await r.done;
    const types = events.since("u", 0).events.map((e) => e.body.type);
    expect(types).toContain("tool.called");
    expect(types).toContain("task.progress");
    expect(types).toContain("tool.result");
    const final = events.messagesFor("u", r.conversationId).at(-1)!;
    expect(final.content).toMatch(/buy milk/);
    expect(final.toolCalls?.[0]).toMatchObject({ name: "create_reminder" });
    const r2 = runner.send({ userId: "u", deviceId: "android", conversationId: r.conversationId, clientMsgId: "c2", text: "thanks" });
    await r2.done;
    expect(events.messagesFor("u", r.conversationId)).toHaveLength(4);
    expect(events.snapshot("u").conversations[0]!.lastDeviceId).toBe("android");
  });

  it("routes device tools through the broker and waits for the device", async () => {
    const { events, runner, broker } = setup();
    const unsub = events.subscribe("u", (e) => {
      if (e.body.type === "device.action") setTimeout(() => broker.complete(e.body.action.id, "pixel", true, { scheduled: true }), 20);
    });
    const r = runner.send({ userId: "u", deviceId: "web", clientMsgId: "c1", text: "set an alarm for 6am" });
    await r.done;
    unsub();
    const log = events.since("u", 0).events;
    const action = log.find((e) => e.body.type === "device.action")!.body as Extract<(typeof log)[number]["body"], { type: "device.action" }>;
    expect(action.action).toMatchObject({ name: "set_alarm", arguments: { hour: 6, minute: 0 }, targetDeviceId: "web" });
    expect(log.find((e) => e.body.type === "device.action.done")!.body).toMatchObject({ deviceId: "pixel", ok: true });
    expect(log.find((e) => e.body.type === "tool.result")!.body).toMatchObject({ ok: true, summary: "set_alarm done on pixel" });
    expect(events.messagesFor("u", r.conversationId).at(-1)!.content).toMatch(/alarm is set on your phone/);
  });

  it("times out device actions gracefully and still completes the turn", async () => {
    const { events, runner } = setup();
    const r = runner.send({ userId: "u", deviceId: "web", clientMsgId: "c1", text: "wake me at 7" });
    await r.done;
    const result = events.since("u", 0).events.find((e) => e.body.type === "tool.result")!.body as { ok: boolean; summary: string };
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no device/);
    expect(events.messagesFor("u", r.conversationId).at(-1)!.status).toBe("complete");
  });

  it("deduplicates retries by clientMsgId and marks provider failures", async () => {
    const { events, runner } = setup();
    const a = runner.send({ userId: "u", deviceId: "web", clientMsgId: "same", text: "hello" });
    await a.done;
    const b = runner.send({ userId: "u", deviceId: "web", clientMsgId: "same", text: "hello" });
    expect(b.deduplicated).toBe(true);
    expect(b.conversationId).toBe(a.conversationId);
    expect(b.assistantMessageId).toBe(a.assistantMessageId);
    expect(events.messagesFor("u", a.conversationId)).toHaveLength(2);
    const f = runner.send({ userId: "u", deviceId: "web", clientMsgId: "x", text: "please fail" });
    await f.done;
    expect(events.messagesFor("u", f.conversationId).at(-1)).toMatchObject({ status: "error" });
  });

  it("cancel aborts a streaming turn", async () => {
    const { events, runner } = setup(new MockProvider(15));
    const r = runner.send({ userId: "u", deviceId: "web", clientMsgId: "c", text: "tell me something long" });
    await new Promise((res) => setTimeout(res, 40));
    expect(runner.cancel(r.conversationId)).toBe(true);
    await r.done;
    expect(events.messagesFor("u", r.conversationId).at(-1)!.status).toBe("cancelled");
  });
});
