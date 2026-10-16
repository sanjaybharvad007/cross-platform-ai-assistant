/**
 * SyncClient: one WebSocket per tab with resume, an offline outbox and the
 * projected state.  Cursor and state are cached in IndexedDB so a reload is
 * instant and the socket only replays what happened since.
 *
 *   connect() -> hello{since: cursor} -> replay -> synced -> live
 *   send()    -> outbox (persisted) -> flushed when connected -> ack removes it
 *   device.action events for this device are dispatched to the registered handler
 */
import { get, set } from "idb-keyval";
import { applyEvent, emptyState, parse, PROTOCOL_VERSION, ServerFrame, type AssistantState, type ClientFrame, type Device, type DeviceAction } from "@assistant/protocol";
import { wsUrl } from "./api";

export type ConnState = "offline" | "connecting" | "syncing" | "live";
export interface Outgoing { clientMsgId: string; conversationId?: string; text: string; at: number }
export interface ToolOutcome { ok: boolean; summary: string }
export interface Progress { step: number; total: number; label: string }
export interface SyncSnapshot {
  state: AssistantState; conn: ConnState; devices: Device[]; outbox: Outgoing[]; pendingClientIds: Set<string>;
  /** per assistant message: tool call id -> outcome (UI detail not part of the core projection) */
  toolResults: Record<string, Record<string, ToolOutcome>>;
  progress: Record<string, Progress>;
}
type Listener = (s: SyncSnapshot) => void;
export type DeviceActionHandler = (a: DeviceAction) => Promise<{ ok: boolean; result: unknown }>;

export class SyncClient {
  state: AssistantState = emptyState();
  conn: ConnState = "offline";
  devices: Device[] = [];
  outbox: Outgoing[] = [];
  toolResults: Record<string, Record<string, ToolOutcome>> = {};
  progress: Record<string, Progress> = {};
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private backoff = 500;
  private closed = false;
  private persistTimer: number | undefined;
  private handledActions = new Set<string>();
  onDeviceAction: DeviceActionHandler | null = null;

  constructor(private readonly token: string, readonly deviceId: string, private readonly stateKey = `assistant.state.${deviceId}`) {}

  subscribe(l: Listener): () => void { this.listeners.add(l); l(this.snapshot()); return () => this.listeners.delete(l); }
  snapshot(): SyncSnapshot { return { state: this.state, conn: this.conn, devices: this.devices, outbox: this.outbox, pendingClientIds: new Set(this.outbox.map((o) => o.clientMsgId)), toolResults: this.toolResults, progress: this.progress }; }
  private emit() { const s = this.snapshot(); for (const l of this.listeners) l(s); this.schedulePersist(); }

  async start() {
    const cached = await get<{ state: AssistantState; outbox: Outgoing[]; toolResults?: SyncClient["toolResults"] }>(this.stateKey);
    if (cached) { this.state = cached.state; this.outbox = cached.outbox ?? []; this.toolResults = cached.toolResults ?? {}; }
    this.emit();
    this.connect();
    // Browsers tell us when the network goes away: drop the socket at once so sends queue instead of
    // disappearing into a half-open connection, and reconnect immediately when it is back.
    addEventListener("offline", () => { this.ws?.close(); });
    addEventListener("online", () => { this.backoff = 500; this.connect(); });
  }

  stop() { this.closed = true; this.ws?.close(); }

  private connect() {
    if (this.closed || (this.ws && this.ws.readyState <= WebSocket.OPEN) || !navigator.onLine) return;
    this.conn = "connecting"; this.emit();
    const ws = new WebSocket(wsUrl(this.token));
    this.ws = ws;
    ws.onopen = () => { this.conn = "syncing"; this.emit(); };
    ws.onmessage = (m) => this.handle(parse(ServerFrame, JSON.parse(m.data as string)));
    ws.onclose = () => { this.ws = null; this.conn = "offline"; this.emit(); if (!this.closed) { setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(this.backoff * 2, 15_000); } };
    ws.onerror = () => ws.close();
  }

  private handle(f: ServerFrame) {
    switch (f.type) {
      case "welcome": this.devices = f.devices; this.sendFrame({ type: "hello", since: this.state.seq, protocol: PROTOCOL_VERSION }); break;
      case "event": {
        if (f.event.seq <= this.state.seq) break; // duplicate from an overlapping replay
        this.state = applyEvent(this.state, f.event);
        const b = f.event.body;
        if (b.type === "tool.result") this.toolResults = { ...this.toolResults, [b.messageId]: { ...(this.toolResults[b.messageId] ?? {}), [b.toolCallId]: { ok: b.ok, summary: b.summary } } };
        if (b.type === "task.progress") this.progress = { ...this.progress, [b.messageId]: { step: b.step, total: b.total, label: b.label } };
        if (b.type === "device.action" && (!b.action.targetDeviceId || b.action.targetDeviceId === this.deviceId) && b.action.expiresAt > Date.now()) void this.runAction(b.action);
        break;
      }
      case "synced":
        this.conn = "live"; this.backoff = 500;
        // actions that were pending while we were away and are still unexpired
        for (const a of Object.values(this.state.pendingActions)) if (a.expiresAt > Date.now()) void this.runAction(a);
        this.flush();
        break;
      case "presence": this.devices = f.devices; break;
      case "ack": this.outbox = this.outbox.filter((o) => o.clientMsgId !== f.clientMsgId); break;
      case "error": if (f.clientMsgId) this.outbox = this.outbox.filter((o) => o.clientMsgId !== f.clientMsgId); console.warn("server error", f); break;
      case "pong": break;
    }
    this.emit();
  }

  private async runAction(a: DeviceAction) {
    if (this.handledActions.has(a.id) || !this.onDeviceAction) return;
    this.handledActions.add(a.id);
    const r = await this.onDeviceAction(a).catch((e) => ({ ok: false, result: { error: String(e) } }));
    this.sendFrame({ type: "device.result", actionId: a.id, ok: r.ok, result: r.result });
  }

  send(text: string, conversationId?: string): string {
    const clientMsgId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.outbox.push({ clientMsgId, conversationId, text, at: Date.now() });
    this.emit();
    this.flush();
    return clientMsgId;
  }
  cancel(conversationId: string) { this.sendFrame({ type: "cancel", conversationId }); }

  private flush() { if (this.conn !== "live") return; for (const o of this.outbox) this.sendFrame({ type: "send", clientMsgId: o.clientMsgId, conversationId: o.conversationId, text: o.text }); }
  private sendFrame(f: ClientFrame) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f)); }
  private schedulePersist() { clearTimeout(this.persistTimer); this.persistTimer = window.setTimeout(() => void set(this.stateKey, { state: this.state, outbox: this.outbox, toolResults: this.toolResults }).catch(() => {}), 150); }
}
