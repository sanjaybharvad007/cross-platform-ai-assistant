import { describe, expect, it } from "vitest";
import { applyEvents, emptyState, sortedConversations } from "@assistant/protocol";
import { Auth, AuthError } from "../src/auth.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/events.js";

describe("event store", () => {
  it("assigns per-user monotonically increasing seq and projects conversations/messages", () => {
    const db = openDb(":memory:");
    const es = new EventStore(db);
    const now = 1000;
    es.append("u1", { type: "conversation.created", conversation: { id: "c1", title: "t", createdAt: now, updatedAt: now, archived: false } }, now);
    es.append("u2", { type: "conversation.created", conversation: { id: "c9", title: "other user", createdAt: now, updatedAt: now, archived: false } }, now);
    es.append("u1", { type: "message.created", message: { id: "m1", conversationId: "c1", role: "user", content: "hi", status: "complete", createdAt: now + 1, deviceId: "d1", clientMsgId: "k1" } }, now + 1);
    es.append("u1", { type: "message.created", message: { id: "m2", conversationId: "c1", role: "assistant", content: "", status: "streaming", createdAt: now + 2 } }, now + 2);
    es.append("u1", { type: "message.delta", conversationId: "c1", messageId: "m2", delta: "Hel" }, now + 3);
    es.append("u1", { type: "message.delta", conversationId: "c1", messageId: "m2", delta: "lo" }, now + 4);
    es.append("u1", { type: "message.completed", conversationId: "c1", messageId: "m2", status: "complete" }, now + 5);
    expect(es.head("u1")).toBe(6);
    expect(es.head("u2")).toBe(1);
    const snap = es.snapshot("u1");
    expect(snap.conversations.map((c) => c.id)).toEqual(["c1"]);
    expect(snap.messages.map((m) => [m.id, m.content, m.status])).toEqual([["m1", "hi", "complete"], ["m2", "Hello", "complete"]]);
    expect(snap.conversations[0]!.lastDeviceId).toBe("d1");
    // projection from the log equals the SQL projection
    const folded = applyEvents(emptyState(), es.since("u1", 0).events);
    expect(sortedConversations(folded).map((c) => c.id)).toEqual(["c1"]);
    expect(folded.messages.m2!.content).toBe("Hello");
    expect(es.findByClientMsgId("u1", "k1")).toEqual({ messageId: "m1", conversationId: "c1" });
  });
  it("pages replay and notifies subscribers", () => {
    const es = new EventStore(openDb(":memory:"));
    const seen: number[] = [];
    const off = es.subscribe("u", (e) => seen.push(e.seq));
    for (let i = 0; i < 7; i++) es.append("u", { type: "conversation.created", conversation: { id: `c${i}`, title: "t", createdAt: i, updatedAt: i, archived: false } }, i);
    off();
    es.append("u", { type: "conversation.deleted", conversationId: "c0" });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const p1 = es.since("u", 0, 5);
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(p1.hasMore).toBe(true);
    const p2 = es.since("u", 5, 5);
    expect(p2.events.map((e) => e.seq)).toEqual([6, 7, 8]);
    expect(p2.hasMore).toBe(false);
    expect(es.snapshot("u").conversations.find((c) => c.id === "c0")).toBeUndefined();
  });
});

describe("auth", () => {
  it("registers devices, signs and verifies tokens, pairs by code", async () => {
    const db = openDb(":memory:");
    const auth = new Auth(db, "0123456789abcdef0123456789abcdef");
    const a = await auth.registerDevice("Chrome", "web");
    const id = await auth.verify(a.token);
    expect(id).toEqual({ userId: a.userId, deviceId: a.deviceId });
    const { code } = auth.createPairCode(a.userId);
    expect(code).toMatch(/^\d{6}$/);
    const b = await auth.registerDevice("Pixel", "android", code);
    expect(b.userId).toBe(a.userId);
    expect(b.deviceId).not.toBe(a.deviceId);
    await expect(auth.registerDevice("x", "web", code)).rejects.toBeInstanceOf(AuthError); // single use
    await expect(auth.verify(a.token + "x")).rejects.toBeInstanceOf(AuthError);
    expect(auth.devices(a.userId, new Set([b.deviceId])).map((d) => [d.platform, d.online])).toEqual([["android", true], ["web", false]]);
  });
});
