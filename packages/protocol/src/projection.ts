/**
 * Client-side state projection: fold events into conversations + messages.
 * Pure and deterministic, identical on web, server (for snapshots) and
 * Android (Kotlin port in android/core), so every surface converges on the
 * same state from the same event log.  Applying an event twice or out of
 * order below the cursor is a no-op, which is what makes reconnect/replay safe.
 */
import type { Conversation, DeviceAction, Event, Message } from "./index.js";

export interface AssistantState {
  seq: number;
  conversations: Record<string, Conversation>;
  messages: Record<string, Message>;
  /** message ids per conversation in creation order */
  order: Record<string, string[]>;
  pendingActions: Record<string, DeviceAction>;
}

export function emptyState(): AssistantState {
  return { seq: 0, conversations: {}, messages: {}, order: {}, pendingActions: {} };
}

export function applyEvent(state: AssistantState, ev: Event): AssistantState {
  if (ev.seq <= state.seq) return state; // already applied (replay / duplicate)
  const s: AssistantState = { ...state, seq: ev.seq };
  const b = ev.body;
  switch (b.type) {
    case "conversation.created":
      s.conversations = { ...s.conversations, [b.conversation.id]: b.conversation };
      s.order = { ...s.order, [b.conversation.id]: s.order[b.conversation.id] ?? [] };
      break;
    case "conversation.updated": {
      const c = s.conversations[b.conversationId];
      if (c) s.conversations = { ...s.conversations, [b.conversationId]: { ...c, ...b.patch } };
      break;
    }
    case "conversation.deleted": {
      const { [b.conversationId]: _c, ...rest } = s.conversations;
      s.conversations = rest;
      const ids = s.order[b.conversationId] ?? [];
      const msgs = { ...s.messages };
      for (const id of ids) delete msgs[id];
      s.messages = msgs;
      const { [b.conversationId]: _o, ...order } = s.order;
      s.order = order;
      break;
    }
    case "message.created":
      s.messages = { ...s.messages, [b.message.id]: b.message };
      if (!(s.order[b.message.conversationId] ?? []).includes(b.message.id))
        s.order = { ...s.order, [b.message.conversationId]: [...(s.order[b.message.conversationId] ?? []), b.message.id] };
      touch(s, b.message.conversationId, ev.at, b.message.deviceId);
      break;
    case "message.delta": {
      const m = s.messages[b.messageId];
      if (m) s.messages = { ...s.messages, [b.messageId]: { ...m, content: m.content + b.delta } };
      break;
    }
    case "message.completed": {
      const m = s.messages[b.messageId];
      if (m) s.messages = { ...s.messages, [b.messageId]: { ...m, status: b.status } };
      touch(s, b.conversationId, ev.at);
      break;
    }
    case "tool.called": {
      const m = s.messages[b.messageId];
      if (m) s.messages = { ...s.messages, [b.messageId]: { ...m, toolCalls: [...(m.toolCalls ?? []).filter((c) => c.id !== b.call.id), b.call] } };
      break;
    }
    case "device.action":
      s.pendingActions = { ...s.pendingActions, [b.action.id]: b.action };
      break;
    case "device.action.done": {
      const { [b.actionId]: _a, ...rest } = s.pendingActions;
      s.pendingActions = rest;
      break;
    }
    case "tool.result":
    case "task.progress":
      break;
  }
  return s;
}

function touch(s: AssistantState, conversationId: string, at: number, deviceId?: string) {
  const c = s.conversations[conversationId];
  if (c) s.conversations = { ...s.conversations, [conversationId]: { ...c, updatedAt: Math.max(c.updatedAt, at), lastDeviceId: deviceId ?? c.lastDeviceId } };
}

export function applyEvents(state: AssistantState, events: Event[]): AssistantState {
  return events.reduce(applyEvent, state);
}

export function conversationMessages(state: AssistantState, conversationId: string): Message[] {
  return (state.order[conversationId] ?? []).map((id) => state.messages[id]!).filter(Boolean);
}

export function sortedConversations(state: AssistantState): Conversation[] {
  return Object.values(state.conversations).filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt);
}
