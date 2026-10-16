/**
 * Turns a user message into events: creates the conversation if needed,
 * records the user message, then runs the agent loop for the assistant reply.
 * Every observable step - streamed text, tool calls, device actions, progress,
 * completion - is appended to the event log, which is what lets a second
 * device (or the same device after a reconnect) render the turn as it
 * happens or replay it later.
 */
import type { Conversation, DeviceAction, Message } from "@assistant/protocol";
import type { Config } from "../config.js";
import { newId, type Db } from "../db.js";
import type { EventStore } from "../events.js";
import type { ChatMessage, Provider } from "../providers/types.js";
import type { DeviceBroker } from "../tools/device-broker.js";
import { executorOf, runTool, toolSpecs } from "../tools/registry.js";

export interface SendInput {
  userId: string;
  deviceId: string;
  conversationId?: string;
  clientMsgId: string;
  text: string;
}
export interface SendResult {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  /** Resolves when the assistant turn is complete (or failed / cancelled). */
  done: Promise<void>;
  deduplicated: boolean;
}

const SYSTEM = `You are a personal assistant that follows the user across their devices (web and Android).
Be concise and practical. Use tools to act instead of describing what the user could do:
server tools (time, calculator, weather, reminders, notes, fetching pages) and device tools
(open a URL, set an alarm, share, clipboard, notifications, location) which run on the user's phone or browser.
For multi-step requests, do the steps in order and report what you did. If a device action fails
because no device is available, say so and offer to retry.`;

export class AgentRunner {
  private running = new Map<string, AbortController>(); // conversationId -> controller
  constructor(
    private readonly deps: { db: Db; events: EventStore; provider: Provider; broker: DeviceBroker; cfg: Config; fetch?: typeof fetch; now?: () => number },
  ) {}

  private now() { return this.deps.now?.() ?? Date.now(); }

  send(input: SendInput): SendResult {
    const { events } = this.deps;
    // idempotency: the same clientMsgId from a retrying client must not create a second turn
    const existing = events.findByClientMsgId(input.userId, input.clientMsgId);
    if (existing) {
      const msgs = events.messagesFor(input.userId, existing.conversationId);
      const idx = msgs.findIndex((m) => m.id === existing.messageId);
      const assistant = msgs.slice(idx + 1).find((m) => m.role === "assistant");
      return { conversationId: existing.conversationId, userMessageId: existing.messageId, assistantMessageId: assistant?.id ?? "", done: Promise.resolve(), deduplicated: true };
    }
    const at = this.now();
    let conversationId = input.conversationId;
    if (!conversationId) {
      conversationId = newId("conv");
      const conv: Conversation = { id: conversationId, title: titleFrom(input.text), createdAt: at, updatedAt: at, lastDeviceId: input.deviceId, archived: false };
      events.append(input.userId, { type: "conversation.created", conversation: conv }, at);
    }
    const userMsg: Message = { id: newId("msg"), conversationId, role: "user", content: input.text, deviceId: input.deviceId, clientMsgId: input.clientMsgId, status: "complete", createdAt: at };
    events.append(input.userId, { type: "message.created", message: userMsg }, at);
    const assistantMsg: Message = { id: newId("msg"), conversationId, role: "assistant", content: "", status: "streaming", createdAt: at + 1 };
    events.append(input.userId, { type: "message.created", message: assistantMsg }, at + 1);

    this.running.get(conversationId)?.abort();
    const ac = new AbortController();
    this.running.set(conversationId, ac);
    const done = this.runTurn(input.userId, input.deviceId, conversationId, assistantMsg.id, ac).finally(() => {
      if (this.running.get(conversationId!) === ac) this.running.delete(conversationId!);
    });
    return { conversationId, userMessageId: userMsg.id, assistantMessageId: assistantMsg.id, done, deduplicated: false };
  }

  cancel(conversationId: string): boolean {
    const ac = this.running.get(conversationId);
    if (!ac) return false;
    ac.abort();
    this.deps.broker.cancelAll(conversationId);
    return true;
  }

  private async runTurn(userId: string, deviceId: string, conversationId: string, messageId: string, ac: AbortController) {
    const { events, provider, cfg, db, broker } = this.deps;
    const emit = (body: Parameters<EventStore["append"]>[1]) => events.append(userId, body, this.now());
    const history = events.messagesFor(userId, conversationId).filter((m) => m.id !== messageId && m.status === "complete");
    const messages: ChatMessage[] = history.slice(-40).map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls, toolCallId: m.toolCallId }));
    let usage = { input: 0, output: 0 };
    let buffer = "";
    const flush = () => { if (buffer) { emit({ type: "message.delta", conversationId, messageId, delta: buffer }); buffer = ""; } };

    try {
      for (let step = 0; step <= cfg.MAX_TOOL_STEPS; step++) {
        if (ac.signal.aborted) throw new DOMException("aborted", "AbortError");
        const tools = step === cfg.MAX_TOOL_STEPS ? [] : toolSpecs();
        let text = "";
        const calls: Message["toolCalls"] = [];
        for await (const ev of provider.stream({ model: cfg.LLM_MODEL, system: SYSTEM, messages: [...messages], tools, temperature: 0.3, signal: ac.signal })) {
          if (ac.signal.aborted) throw new DOMException("aborted", "AbortError"); // providers that ignore the signal
          if (ev.type === "delta") {
            text += ev.text;
            buffer += ev.text;
            if (buffer.length >= 24 || /[.!?\n]\s*$/.test(buffer)) flush();
          } else if (ev.type === "toolCall") calls.push(ev.call);
          else if (ev.type === "usage") usage = { input: usage.input + ev.input, output: usage.output + ev.output };
        }
        flush();
        if (!calls.length) {
          messages.push({ role: "assistant", content: text });
          emit({ type: "message.completed", conversationId, messageId, status: "complete", usage });
          return;
        }
        messages.push({ role: "assistant", content: text, toolCalls: calls });
        for (const [i, call] of calls.entries()) {
          const executor = executorOf(call.name);
          emit({ type: "tool.called", conversationId, messageId, call, executor });
          emit({ type: "task.progress", conversationId, messageId, step: step * calls.length + i + 1, total: (step + 1) * calls.length, label: labelFor(call.name) });
          const result = await runTool(call.name, call.arguments, {
            userId, deviceId, conversationId, messageId, db, fetch: this.deps.fetch ?? fetch, now: () => this.now(),
            runOnDevice: async (name, args, target) => {
              const action: DeviceAction = { id: newId("act"), conversationId, messageId, toolCallId: call.id, name, arguments: args, targetDeviceId: target ?? deviceId, expiresAt: this.now() + cfg.DEVICE_ACTION_TIMEOUT_MS };
              const wait = broker.wait(action, cfg.DEVICE_ACTION_TIMEOUT_MS);
              emit({ type: "device.action", action });
              const r = await wait;
              emit({ type: "device.action.done", actionId: action.id, deviceId: r.deviceId || deviceId, ok: r.ok });
              return r;
            },
          });
          emit({ type: "tool.result", conversationId, messageId, toolCallId: call.id, ok: result.ok, summary: result.summary });
          messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result.ok ? result.data : { error: result.summary }).slice(0, 16_000) });
        }
        if (text) {
          buffer = "\n\n";
          flush();
        }
      }
      emit({ type: "message.completed", conversationId, messageId, status: "error", error: "tool step budget exhausted", usage });
    } catch (e) {
      flush();
      const cancelled = (e as Error).name === "AbortError";
      emit({ type: "message.completed", conversationId, messageId, status: cancelled ? "cancelled" : "error", error: cancelled ? undefined : (e as Error).message, usage });
    }
  }
}

export function titleFrom(text: string): string {
  const words = text.trim().replace(/\s+/g, " ").split(" ");
  const t = words.slice(0, 7).join(" ");
  return (t.length > 48 ? t.slice(0, 47) + "…" : t) + (words.length > 7 && t.length <= 48 ? "…" : "");
}
const labelFor = (name: string) => ({ get_weather: "Checking weather", create_reminder: "Creating reminder", set_alarm: "Setting alarm on your phone", open_url: "Opening link", save_note: "Saving note", search_notes: "Searching notes", fetch_url: "Reading page", calculate: "Calculating", get_time: "Checking time", list_reminders: "Listing reminders", share_text: "Opening share sheet", get_location: "Getting location", copy_to_clipboard: "Copying", notify: "Notifying" } as Record<string, string>)[name] ?? `Running ${name}`;
