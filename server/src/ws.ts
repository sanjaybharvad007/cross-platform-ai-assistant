/**
 * WebSocket session per device.  Protocol (see @assistant/protocol):
 *   client: hello{since} -> server: welcome, event* (replay > since), synced, then live events
 *   client: send / cancel / device.result / ping
 * Presence is derived from live sockets and broadcast to the user's devices.
 */
import type { WebSocket } from "ws";
import { ClientFrame, PROTOCOL_VERSION, parse, type Device, type Event, type ServerFrame } from "@assistant/protocol";
import type { Auth, Identity } from "./auth.js";
import type { AgentRunner } from "./agent/runner.js";
import type { EventStore } from "./events.js";
import type { DeviceBroker } from "./tools/device-broker.js";

export interface WsDeps { auth: Auth; events: EventStore; runner: AgentRunner; broker: DeviceBroker; log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void } }

export class Presence {
  private online = new Map<string, Map<string, Set<WebSocket>>>(); // userId -> deviceId -> sockets
  add(id: Identity, ws: WebSocket) {
    const u = this.online.get(id.userId) ?? new Map();
    const d = u.get(id.deviceId) ?? new Set();
    d.add(ws); u.set(id.deviceId, d); this.online.set(id.userId, u);
  }
  remove(id: Identity, ws: WebSocket) {
    const d = this.online.get(id.userId)?.get(id.deviceId);
    d?.delete(ws);
    if (d && d.size === 0) this.online.get(id.userId)!.delete(id.deviceId);
  }
  devices(userId: string): Set<string> { return new Set(this.online.get(userId)?.keys() ?? []); }
  sockets(userId: string): WebSocket[] { return [...(this.online.get(userId)?.values() ?? [])].flatMap((s) => [...s]); }
}

export function handleSocket(ws: WebSocket, id: Identity, deps: WsDeps, presence: Presence) {
  const send = (f: ServerFrame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f)); };
  const devices = (): Device[] => deps.auth.devices(id.userId, presence.devices(id.userId));
  const broadcastPresence = () => { const frame = JSON.stringify({ type: "presence", devices: devices() } satisfies ServerFrame); for (const s of presence.sockets(id.userId)) if (s.readyState === s.OPEN) s.send(frame); };

  let live = false;
  let replayHead = 0;
  const queued: Event[] = [];
  const unsubscribe = deps.events.subscribe(id.userId, (ev) => {
    if (!live) { queued.push(ev); return; }
    send({ type: "event", event: ev });
  });
  presence.add(id, ws);
  deps.auth.touchDevice(id.deviceId);
  send({ type: "welcome", deviceId: id.deviceId, userId: id.userId, serverSeq: deps.events.head(id.userId), devices: devices() });
  broadcastPresence();

  ws.on("message", (raw) => {
    let frame;
    try { frame = parse(ClientFrame, JSON.parse(String(raw))); } catch (e) { send({ type: "error", code: "bad_frame", message: (e as Error).message }); return; }
    switch (frame.type) {
      case "hello": {
        if (frame.protocol !== PROTOCOL_VERSION) { send({ type: "error", code: "protocol", message: `unsupported protocol ${frame.protocol}` }); ws.close(); return; }
        // replay in pages, then switch to live and drain anything that arrived meanwhile
        let since = frame.since;
        for (;;) {
          const page = deps.events.since(id.userId, since, 500);
          for (const ev of page.events) { send({ type: "event", event: ev }); replayHead = ev.seq; }
          since = replayHead;
          if (!page.hasMore) break;
        }
        live = true;
        for (const ev of queued) if (ev.seq > replayHead) { send({ type: "event", event: ev }); replayHead = ev.seq; }
        queued.length = 0;
        send({ type: "synced", seq: Math.max(replayHead, frame.since) });
        break;
      }
      case "send": {
        try {
          const r = deps.runner.send({ userId: id.userId, deviceId: id.deviceId, conversationId: frame.conversationId, clientMsgId: frame.clientMsgId, text: frame.text });
          send({ type: "ack", clientMsgId: frame.clientMsgId, messageId: r.userMessageId, conversationId: r.conversationId });
        } catch (e) { send({ type: "error", code: "send_failed", message: (e as Error).message, clientMsgId: frame.clientMsgId }); }
        break;
      }
      case "cancel":
        deps.runner.cancel(frame.conversationId);
        break;
      case "device.result":
        if (!deps.broker.complete(frame.actionId, id.deviceId, frame.ok, frame.result)) send({ type: "error", code: "unknown_action", message: `action ${frame.actionId} is not pending` });
        break;
      case "ping":
        deps.auth.touchDevice(id.deviceId);
        send({ type: "pong", t: frame.t });
        break;
    }
  });
  ws.on("close", () => { unsubscribe(); presence.remove(id, ws); deps.auth.touchDevice(id.deviceId); broadcastPresence(); });
  ws.on("error", (e) => deps.log.warn({ err: e.message, deviceId: id.deviceId }, "ws error"));
}
