import { useEffect, useRef, useState } from "react";
import { conversationMessages, type Device, type Message } from "@assistant/protocol";
import type { SyncSnapshot } from "../lib/sync";

const SUGGESTIONS = ["What's the weather in Zurich?", "Remind me to call the dentist in an hour", "Set an alarm for 7am on my phone", "What is 1250 * 1.08?", "Save a note: ideas for the weekend"];

export function Chat({ snap, conversationId, deviceId, onSend, onCancel }: { snap: SyncSnapshot; conversationId: string | null; deviceId: string; onSend: (text: string) => void; onCancel: () => void }) {
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const msgs = conversationId ? conversationMessages(snap.state, conversationId) : [];
  const streaming = msgs.some((m) => m.status === "streaming");
  const conv = conversationId ? snap.state.conversations[conversationId] : undefined;
  const lastOther = conv?.lastDeviceId && conv.lastDeviceId !== deviceId ? snap.devices.find((d) => d.id === conv.lastDeviceId) : undefined;
  const pendingForOthers = Object.values(snap.state.pendingActions).filter((a) => a.conversationId === conversationId && a.targetDeviceId && a.targetDeviceId !== deviceId);

  const lastLen = msgs.at(-1)?.content.length ?? 0;
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [msgs.length, lastLen]);

  const submit = () => { if (!input.trim()) return; onSend(input.trim()); setInput(""); };

  return (
    <>
      <div className="messages" ref={listRef} data-testid="messages">
        {!conversationId && (
          <div className="empty">
            <h2>What can I do for you?</h2>
            <div className="small">I can check things, remember things and act on your devices. Start here or ask anything.</div>
            <div className="chips">{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => onSend(s)}>{s}</button>)}</div>
          </div>
        )}
        {lastOther && <div className="continue">Last active on <strong>{lastOther.name}</strong> — continuing here.</div>}
        {msgs.map((m) => <MessageView key={m.id} m={m} snap={snap} devices={snap.devices} />)}
        {pendingForOthers.map((a) => <div key={a.id} className="action-banner">Waiting for <strong>{snap.devices.find((d) => d.id === a.targetDeviceId)?.name ?? "another device"}</strong> to run <code>{a.name}</code>…</div>)}
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="inner">
          <textarea className="input" data-testid="composer" rows={2} placeholder="Message your assistant…" value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
          <div className="actions">
            <span className="small muted">{snap.outbox.length ? `${snap.outbox.length} queued · sends when online` : snap.conn === "live" ? "Synced" : snap.conn}</span>
            {streaming ? <button type="button" className="btn" onClick={onCancel}>Stop</button> : <button className="btn primary" disabled={!input.trim()} data-testid="send">Send</button>}
          </div>
        </div>
      </form>
    </>
  );
}

function MessageView({ m, snap, devices }: { m: Message; snap: SyncSnapshot; devices: Device[] }) {
  if (m.role === "user") {
    const from = devices.find((d) => d.id === m.deviceId);
    const queued = m.clientMsgId && snap.pendingClientIds.has(m.clientMsgId);
    return <div className="msg user" data-testid="user-msg">{m.content}<div className="meta">{queued ? "sending…" : from ? `from ${from.name}` : ""}</div></div>;
  }
  if (m.role !== "assistant") return null;
  const calls = m.toolCalls ?? [];
  const results = resultsFor(snap, m.id);
  const progress = progressFor(snap, m.id);
  return (
    <div className={`msg assistant ${m.status === "streaming" ? "pending" : ""}`} data-testid="assistant-msg" data-status={m.status}>
      {progress && m.status === "streaming" && <div className="progress"><span>{progress.label}</span><span className="bar"><i style={{ width: `${(100 * progress.step) / progress.total}%` }} /></span></div>}
      {calls.length > 0 && (
        <div className="tools">
          {calls.map((c) => { const r = results[c.id]; const isDevice = ["open_url", "set_alarm", "share_text", "get_location", "copy_to_clipboard", "notify"].includes(c.name); return (
            <div key={c.id} className={`toolcard ${isDevice ? "device" : ""} ${r && !r.ok ? "err" : ""}`} data-testid="tool-card"><span className="k">{c.name}</span><span>{r ? r.summary : "running…"}</span></div>); })}
        </div>
      )}
      <div className="body">{m.content}</div>
      {m.status === "error" && <div className="status-line" style={{ color: "var(--err)" }}>Something went wrong. Try again.</div>}
      {m.status === "cancelled" && <div className="status-line">Stopped.</div>}
    </div>
  );
}

/* tool results and progress are not part of the Message projection; derive them from the recent event tail kept by the client */
function resultsFor(snap: SyncSnapshot, messageId: string): Record<string, { ok: boolean; summary: string }> { return snap.toolResults?.[messageId] ?? {}; }
function progressFor(snap: SyncSnapshot, messageId: string) { return snap.progress?.[messageId]; }
