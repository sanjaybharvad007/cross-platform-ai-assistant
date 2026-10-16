/**
 * Writes canonical JSON fixtures for the protocol so the Kotlin client's
 * serializers can be contract-tested against exactly what the server emits.
 * Run `npm run fixtures` after changing the protocol; CI fails if they drift.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Event, ServerFrame, ClientFrame, parse } from "../src/index.js";

const now = 1_760_000_000_000;
const events = [
  { seq: 1, at: now, body: { type: "conversation.created", conversation: { id: "conv_1", title: "Trip to Zurich", createdAt: now, updatedAt: now, archived: false } } },
  { seq: 2, at: now + 1, body: { type: "message.created", message: { id: "msg_u1", conversationId: "conv_1", role: "user", content: "Plan a 2-day trip to Zurich", deviceId: "dev_web", clientMsgId: "c_1", status: "complete", createdAt: now + 1 } } },
  { seq: 3, at: now + 2, body: { type: "message.created", message: { id: "msg_a1", conversationId: "conv_1", role: "assistant", content: "", status: "streaming", createdAt: now + 2 } } },
  { seq: 4, at: now + 3, body: { type: "tool.called", conversationId: "conv_1", messageId: "msg_a1", call: { id: "call_1", name: "get_weather", arguments: { city: "Zurich" } }, executor: "server" } },
  { seq: 5, at: now + 4, body: { type: "tool.result", conversationId: "conv_1", messageId: "msg_a1", toolCallId: "call_1", ok: true, summary: "12°C, light rain" } },
  { seq: 6, at: now + 5, body: { type: "task.progress", conversationId: "conv_1", messageId: "msg_a1", step: 1, total: 3, label: "Checking weather" } },
  { seq: 7, at: now + 6, body: { type: "message.delta", conversationId: "conv_1", messageId: "msg_a1", delta: "Day 1: Old Town and the lake. " } },
  { seq: 8, at: now + 7, body: { type: "device.action", action: { id: "act_1", conversationId: "conv_1", messageId: "msg_a1", toolCallId: "call_2", name: "set_alarm", arguments: { hour: 7, minute: 30, label: "Train to Zurich" }, targetDeviceId: "dev_android", expiresAt: now + 60_000 } } },
  { seq: 9, at: now + 8, body: { type: "device.action.done", actionId: "act_1", deviceId: "dev_android", ok: true } },
  { seq: 10, at: now + 9, body: { type: "message.completed", conversationId: "conv_1", messageId: "msg_a1", status: "complete", usage: { input: 812, output: 140 } } },
  { seq: 11, at: now + 10, body: { type: "conversation.updated", conversationId: "conv_1", patch: { title: "Zurich weekend", lastDeviceId: "dev_android", updatedAt: now + 10 } } },
].map((e) => parse(Event, e));

const serverFrames = [
  { type: "welcome", deviceId: "dev_web", userId: "usr_1", serverSeq: 11, devices: [{ id: "dev_web", name: "Chrome on Mac", platform: "web", lastSeenAt: now, online: true }, { id: "dev_android", name: "Pixel 8", platform: "android", lastSeenAt: now - 5000, online: false }] },
  { type: "event", event: events[6] },
  { type: "synced", seq: 11 },
  { type: "ack", clientMsgId: "c_1", messageId: "msg_u1", conversationId: "conv_1" },
  { type: "error", code: "rate_limited", message: "Too many requests", clientMsgId: "c_2" },
  { type: "pong", t: now },
].map((f) => parse(ServerFrame, f));

const clientFrames = [
  { type: "hello", since: 0, protocol: 1 },
  { type: "send", conversationId: "conv_1", clientMsgId: "c_3", text: "What about day 2?" },
  { type: "cancel", conversationId: "conv_1" },
  { type: "device.result", actionId: "act_1", ok: true, result: { scheduled: true } },
  { type: "ping", t: now },
].map((f) => parse(ClientFrame, f));

mkdirSync("packages/protocol/fixtures", { recursive: true });
writeFileSync("packages/protocol/fixtures/events.json", JSON.stringify(events, null, 2) + "\n");
writeFileSync("packages/protocol/fixtures/server-frames.json", JSON.stringify(serverFrames, null, 2) + "\n");
writeFileSync("packages/protocol/fixtures/client-frames.json", JSON.stringify(clientFrames, null, 2) + "\n");
console.log(`wrote ${events.length} events, ${serverFrames.length} server frames, ${clientFrames.length} client frames`);
