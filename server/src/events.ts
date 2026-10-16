/**
 * Event store + in-process fan-out.  `append` assigns the next per-user
 * sequence number inside a transaction and updates the projections, so a
 * reader that sees seq N has also seen every effect of events <= N.
 */
import { EventEmitter } from "node:events";
import { Conversation, Event, Message, parse, type EventBody } from "@assistant/protocol";
import { transaction, type Db } from "./db.js";

export class EventStore {
  private bus = new EventEmitter();
  constructor(private readonly db: Db) {
    this.bus.setMaxListeners(0);
  }

  append(userId: string, body: EventBody, at = Date.now()): Event {
    const ev = transaction(this.db, () => {
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE user_id = ?").get(userId) as { s: number };
      const seq = row.s + 1;
      const event = parse(Event, { seq, at, body });
      this.db.prepare("INSERT INTO events(user_id, seq, at, body) VALUES (?, ?, ?, ?)").run(userId, seq, at, JSON.stringify(body));
      this.project(userId, event);
      return event;
    });
    this.bus.emit(userId, ev);
    return ev;
  }

  appendMany(userId: string, bodies: EventBody[]): Event[] {
    return bodies.map((b) => this.append(userId, b));
  }

  since(userId: string, since: number, limit = 500): { events: Event[]; hasMore: boolean } {
    const rows = this.db.prepare("SELECT seq, at, body FROM events WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(userId, since, limit + 1) as Array<{ seq: number; at: number; body: string }>;
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((r) => ({ seq: r.seq, at: r.at, body: JSON.parse(r.body) as EventBody }));
    return { events, hasMore };
  }

  head(userId: string): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE user_id = ?").get(userId) as { s: number }).s;
  }

  subscribe(userId: string, fn: (ev: Event) => void): () => void {
    this.bus.on(userId, fn);
    return () => this.bus.off(userId, fn);
  }

  /* ---- projections ---------------------------------------------------- */
  private project(userId: string, ev: Event) {
    const b = ev.body;
    const d = this.db;
    switch (b.type) {
      case "conversation.created":
        d.prepare("INSERT OR REPLACE INTO conversations(id, user_id, title, created_at, updated_at, last_device_id, archived) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          b.conversation.id, userId, b.conversation.title, b.conversation.createdAt, b.conversation.updatedAt, b.conversation.lastDeviceId ?? null, b.conversation.archived ? 1 : 0);
        break;
      case "conversation.updated": {
        const p = b.patch;
        if (p.title !== undefined) d.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(p.title, b.conversationId);
        if (p.archived !== undefined) d.prepare("UPDATE conversations SET archived = ? WHERE id = ?").run(p.archived ? 1 : 0, b.conversationId);
        if (p.lastDeviceId !== undefined) d.prepare("UPDATE conversations SET last_device_id = ? WHERE id = ?").run(p.lastDeviceId, b.conversationId);
        d.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(p.updatedAt ?? ev.at, b.conversationId);
        break;
      }
      case "conversation.deleted":
        d.prepare("DELETE FROM conversations WHERE id = ?").run(b.conversationId);
        break;
      case "message.created": {
        const m = b.message;
        d.prepare("INSERT OR REPLACE INTO messages(id, conversation_id, user_id, role, content, tool_calls, tool_call_id, device_id, client_msg_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          m.id, m.conversationId, userId, m.role, m.content, m.toolCalls ? JSON.stringify(m.toolCalls) : null, m.toolCallId ?? null, m.deviceId ?? null, m.clientMsgId ?? null, m.status, m.createdAt);
        d.prepare("UPDATE conversations SET updated_at = ?, last_device_id = COALESCE(?, last_device_id) WHERE id = ?").run(ev.at, m.deviceId ?? null, m.conversationId);
        break;
      }
      case "message.delta":
        d.prepare("UPDATE messages SET content = content || ? WHERE id = ?").run(b.delta, b.messageId);
        break;
      case "message.completed":
        d.prepare("UPDATE messages SET status = ? WHERE id = ?").run(b.status, b.messageId);
        d.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(ev.at, b.conversationId);
        break;
      case "tool.called": {
        const row = d.prepare("SELECT tool_calls FROM messages WHERE id = ?").get(b.messageId) as { tool_calls: string | null } | undefined;
        const calls = row?.tool_calls ? (JSON.parse(row.tool_calls) as unknown[]) : [];
        d.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?").run(JSON.stringify([...calls.filter((c) => (c as { id: string }).id !== b.call.id), b.call]), b.messageId);
        break;
      }
      default:
        break;
    }
  }

  /* ---- snapshot (for clients that would rather not replay from 0) ------ */
  snapshot(userId: string): { conversations: Conversation[]; messages: Message[]; seq: number } {
    const conversations = (this.db.prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as Array<Record<string, unknown>>).map((r) =>
      parse(Conversation, { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, lastDeviceId: r.last_device_id ?? undefined, archived: !!r.archived }));
    const messages = (this.db.prepare("SELECT * FROM messages WHERE user_id = ? ORDER BY created_at").all(userId) as Array<Record<string, unknown>>).map((r) =>
      parse(Message, {
        id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content, toolCalls: r.tool_calls ? JSON.parse(r.tool_calls as string) : undefined,
        toolCallId: r.tool_call_id ?? undefined, deviceId: r.device_id ?? undefined, clientMsgId: r.client_msg_id ?? undefined, status: r.status, createdAt: r.created_at,
      }));
    return { conversations, messages, seq: this.head(userId) };
  }

  messagesFor(userId: string, conversationId: string): Message[] {
    return this.snapshot(userId).messages.filter((m) => m.conversationId === conversationId);
  }

  findByClientMsgId(userId: string, clientMsgId: string): { messageId: string; conversationId: string } | undefined {
    const r = this.db.prepare("SELECT id, conversation_id FROM messages WHERE user_id = ? AND client_msg_id = ?").get(userId, clientMsgId) as { id: string; conversation_id: string } | undefined;
    return r ? { messageId: r.id, conversationId: r.conversation_id } : undefined;
  }
}
