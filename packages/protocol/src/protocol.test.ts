import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEvent, applyEvents, ClientFrame, conversationMessages, emptyState, Event, parse, ProtocolError, ServerFrame, sortedConversations } from "./index.js";

const events = (JSON.parse(readFileSync("packages/protocol/fixtures/events.json", "utf8")) as unknown[]).map((e) => parse(Event, e));

describe("protocol", () => {
  it("fixtures round-trip through the schemas", () => {
    for (const f of ["server-frames", "client-frames"]) {
      const raw = JSON.parse(readFileSync(`packages/protocol/fixtures/${f}.json`, "utf8")) as unknown[];
      for (const x of raw) expect(() => parse(f === "server-frames" ? ServerFrame : ClientFrame, x)).not.toThrow();
    }
    expect(events).toHaveLength(11);
  });
  it("rejects malformed frames with a readable error", () => {
    expect(() => parse(ClientFrame, { type: "send", text: "" })).toThrow(ProtocolError);
    expect(() => parse(ClientFrame, { type: "hello", since: -1, protocol: 1 })).toThrow(/since/);
  });
});

describe("projection", () => {
  it("folds the fixture log into conversations and messages", () => {
    const s = applyEvents(emptyState(), events);
    expect(s.seq).toBe(11);
    const conv = sortedConversations(s)[0]!;
    expect(conv.title).toBe("Zurich weekend");
    expect(conv.lastDeviceId).toBe("dev_android");
    const msgs = conversationMessages(s, "conv_1");
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.content).toBe("Day 1: Old Town and the lake. ");
    expect(msgs[1]!.status).toBe("complete");
    expect(msgs[1]!.toolCalls?.[0]?.name).toBe("get_weather");
    expect(Object.keys(s.pendingActions)).toEqual([]); // action done
  });
  it("is idempotent and ignores events at or below the cursor", () => {
    const once = applyEvents(emptyState(), events);
    const twice = applyEvents(once, events);
    expect(twice).toEqual(once);
    const partial = applyEvents(emptyState(), events.slice(0, 7));
    expect(conversationMessages(partial, "conv_1")[1]!.status).toBe("streaming");
    expect(Object.keys(applyEvents(emptyState(), events.slice(0, 8)).pendingActions)).toEqual(["act_1"]);
    // resume from the middle produces the same final state
    expect(applyEvents(partial, events.slice(5))).toEqual(once);
  });
  it("deleting a conversation removes its messages", () => {
    const s = applyEvent(applyEvents(emptyState(), events), { seq: 12, at: 1, body: { type: "conversation.deleted", conversationId: "conv_1" } });
    expect(s.conversations).toEqual({});
    expect(s.messages).toEqual({});
  });
});
