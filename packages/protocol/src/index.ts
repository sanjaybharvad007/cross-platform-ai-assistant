/**
 * Wire protocol shared by the server, the React web client and (mirrored in
 * Kotlin) the Android client.  Conversations are event-sourced: every change
 * is an immutable event with a per-user monotonically increasing sequence
 * number, so any client can resume from its last seen `seq` and arrive at the
 * same state, including in the middle of a streaming assistant turn.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ ids ---- */
export const Id = z.string().min(1).max(64);
export const Seq = z.number().int().nonnegative();

/* ------------------------------------------------------------ messages ---- */
export const Role = z.enum(["user", "assistant", "tool", "system"]);
export type Role = z.infer<typeof Role>;

export const ToolCall = z.object({ id: Id, name: z.string(), arguments: z.record(z.unknown()) });
export type ToolCall = z.infer<typeof ToolCall>;

export const Message = z.object({
  id: Id,
  conversationId: Id,
  role: Role,
  content: z.string(),
  toolCalls: z.array(ToolCall).optional(),
  toolCallId: Id.optional(),
  /** Device that authored the message (user messages) or executed the tool (tool messages). */
  deviceId: Id.optional(),
  /** Client-generated idempotency key for user messages. */
  clientMsgId: Id.optional(),
  status: z.enum(["streaming", "complete", "error", "cancelled"]).default("complete"),
  createdAt: z.number().int(),
});
export type Message = z.infer<typeof Message>;

export const Conversation = z.object({
  id: Id,
  title: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Device that last touched it: lets the UI say "continue from your phone". */
  lastDeviceId: Id.optional(),
  archived: z.boolean().default(false),
});
export type Conversation = z.infer<typeof Conversation>;

export const Device = z.object({
  id: Id,
  name: z.string(),
  platform: z.enum(["web", "android", "ios", "cli"]),
  lastSeenAt: z.number().int(),
  online: z.boolean().default(false),
});
export type Device = z.infer<typeof Device>;

/* -------------------------------------------------------------- events ---- */
/**
 * Device actions are tool calls the server cannot perform itself (open a URL,
 * set an alarm, read location); they are routed to a device, which replies
 * with `DeviceToolResult`.
 */
export const DeviceAction = z.object({
  id: Id,
  conversationId: Id,
  messageId: Id,
  toolCallId: Id,
  name: z.enum(["open_url", "set_alarm", "share_text", "get_location", "copy_to_clipboard", "notify"]),
  arguments: z.record(z.unknown()),
  /** Preferred target device; any online device may fulfil it if absent. */
  targetDeviceId: Id.optional(),
  expiresAt: z.number().int(),
});
export type DeviceAction = z.infer<typeof DeviceAction>;

export const EventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversation.created"), conversation: Conversation }),
  z.object({ type: z.literal("conversation.updated"), conversationId: Id, patch: Conversation.partial().pick({ title: true, archived: true, lastDeviceId: true, updatedAt: true }) }),
  z.object({ type: z.literal("conversation.deleted"), conversationId: Id }),
  z.object({ type: z.literal("message.created"), message: Message }),
  /** Streaming text appended to a message that is still `streaming`. */
  z.object({ type: z.literal("message.delta"), conversationId: Id, messageId: Id, delta: z.string() }),
  z.object({ type: z.literal("message.completed"), conversationId: Id, messageId: Id, status: z.enum(["complete", "error", "cancelled"]), error: z.string().optional(), usage: z.object({ input: z.number(), output: z.number() }).optional() }),
  z.object({ type: z.literal("tool.called"), conversationId: Id, messageId: Id, call: ToolCall, executor: z.enum(["server", "device"]) }),
  z.object({ type: z.literal("tool.result"), conversationId: Id, messageId: Id, toolCallId: Id, ok: z.boolean(), summary: z.string(), deviceId: Id.optional() }),
  z.object({ type: z.literal("device.action"), action: DeviceAction }),
  z.object({ type: z.literal("device.action.done"), actionId: Id, deviceId: Id, ok: z.boolean() }),
  z.object({ type: z.literal("task.progress"), conversationId: Id, messageId: Id, step: z.number().int(), total: z.number().int(), label: z.string() }),
]);
export type EventBody = z.infer<typeof EventBody>;

export const Event = z.object({ seq: Seq, at: z.number().int(), body: EventBody });
export type Event = z.infer<typeof Event>;

/* ------------------------------------------------------- websocket frames ---- */
export const ClientFrame = z.discriminatedUnion("type", [
  /** First frame: resume from `since` (exclusive). The server replays events > since, then streams live. */
  z.object({ type: z.literal("hello"), since: Seq, protocol: z.literal(PROTOCOL_VERSION) }),
  z.object({ type: z.literal("send"), conversationId: Id.optional(), clientMsgId: Id, text: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal("cancel"), conversationId: Id }),
  z.object({ type: z.literal("device.result"), actionId: Id, ok: z.boolean(), result: z.unknown() }),
  z.object({ type: z.literal("ping"), t: z.number().int() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), deviceId: Id, userId: Id, serverSeq: Seq, devices: z.array(Device) }),
  z.object({ type: z.literal("event"), event: Event }),
  /** Replay finished; the client is caught up to `seq`. */
  z.object({ type: z.literal("synced"), seq: Seq }),
  z.object({ type: z.literal("presence"), devices: z.array(Device) }),
  z.object({ type: z.literal("ack"), clientMsgId: Id, messageId: Id, conversationId: Id }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string(), clientMsgId: Id.optional() }),
  z.object({ type: z.literal("pong"), t: z.number().int() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/* -------------------------------------------------------------- REST ---- */
export const RegisterDeviceRequest = z.object({
  name: z.string().min(1).max(80),
  platform: Device.shape.platform,
  /** Pairing code from another signed-in device: joins its user instead of creating a new one. */
  pairCode: z.string().length(6).optional(),
});
export const RegisterDeviceResponse = z.object({ token: z.string(), userId: Id, deviceId: Id });
export const PairCodeResponse = z.object({ code: z.string().length(6), expiresAt: z.number().int() });
export const SyncResponse = z.object({ events: z.array(Event), seq: Seq, hasMore: z.boolean() });
export const SnapshotResponse = z.object({ conversations: z.array(Conversation), messages: z.array(Message), seq: Seq, devices: z.array(Device) });

/* ------------------------------------------------------------ helpers ---- */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ProtocolError(r.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
  return r.data;
}

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export * from "./projection.js";
