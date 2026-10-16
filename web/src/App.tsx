import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { sortedConversations } from "@assistant/protocol";
import { Chat } from "./components/Chat";
import { Onboarding } from "./components/Onboarding";
import { useSync } from "./hooks";
import { api } from "./lib/api";
import { runBrowserAction } from "./lib/device-actions";
import { clearSession, loadSession, type Session } from "./lib/session";
import { SyncClient } from "./lib/sync";

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [client, setClient] = useState<SyncClient | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(() => new URLSearchParams(location.search).get("c"));
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const snap = useSync(client);

  useEffect(() => { void loadSession().then((s) => setSession(s ?? null)); }, []);
  useEffect(() => {
    if (!session) return;
    const c = new SyncClient(session.token, session.deviceId);
    c.onDeviceAction = runBrowserAction;
    void c.start();
    setClient(c);
    return () => c.stop();
  }, [session]);
  useEffect(() => {
    const url = new URL(location.href);
    if (conversationId) url.searchParams.set("c", conversationId); else url.searchParams.delete("c");
    history.replaceState(null, "", url);
  }, [conversationId]);

  const convs = useMemo(() => (snap ? sortedConversations(snap.state) : []), [snap]);
  // a brand-new conversation gets its id from the server; adopt the newest one once it appears
  const [awaitingNew, setAwaitingNew] = useState(false);
  useEffect(() => { if (awaitingNew && convs[0]) { setConversationId(convs[0].id); setAwaitingNew(false); } }, [awaitingNew, convs]);

  const send = useCallback((text: string) => { if (!client) return; client.send(text, conversationId ?? undefined); if (!conversationId) setAwaitingNew(true); }, [client, conversationId]);
  const cancel = useCallback(() => { if (client && conversationId) client.cancel(conversationId); }, [client, conversationId]);
  const showPair = async () => { if (!session) return; setPair(await api("/auth/pair-code", { method: "POST" }, session.token)); };
  const signOut = async () => { client?.stop(); await clearSession(); setSession(null); setClient(null); setConversationId(null); };

  if (session === undefined) return null;
  if (!session) return <Onboarding onDone={setSession} />;
  if (!snap) return null;
  const conn = snap.conn;

  return (
    <div className={`layout ${conversationId ? "has-conv" : ""}`}>
      <aside className="sidebar">
        <header>
          <span className="brand"><img src="/icon.svg" alt="" />Assistant</span>
          <button className="btn sm" onClick={() => setConversationId(null)} data-testid="new-chat">New</button>
        </header>
        <div className="convs" data-testid="conversations">
          {convs.length === 0 && <div className="small muted" style={{ padding: 12 }}>No conversations yet.</div>}
          {convs.map((c) => (
            <button key={c.id} className={`conv ${c.id === conversationId ? "active" : ""}`} onClick={() => setConversationId(c.id)}>
              <span className="t">{c.title}</span>
              <span className="m"><span>{timeAgo(c.updatedAt)}</span>{c.lastDeviceId && c.lastDeviceId !== session.deviceId && <span>· {snap.devices.find((d) => d.id === c.lastDeviceId)?.name ?? "other device"}</span>}</span>
            </button>
          ))}
        </div>
        <div className="devices">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className={`pill ${conn === "live" ? "ok" : conn === "offline" ? "err" : "warn"}`} data-testid="conn"><span className="dot" />{conn}</span>
            <button className="btn sm ghost" onClick={() => void showPair()} data-testid="pair">Add device</button>
          </div>
          {snap.devices.map((d) => <div key={d.id} className={`device ${d.online ? "online" : ""}`} data-testid="device"><span className="dot" />{d.name}{d.id === session.deviceId ? " (this)" : ""}<span className="muted" style={{ marginLeft: "auto" }}>{d.online ? "online" : timeAgo(d.lastSeenAt)}</span></div>)}
          <button className="btn sm ghost" style={{ justifySelf: "start" }} onClick={() => void signOut()}>Sign out of this device</button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          {conversationId && <button className="btn sm ghost" onClick={() => setConversationId(null)} aria-label="Back">←</button>}
          <span className="title" data-testid="title">{conversationId ? (snap.state.conversations[conversationId]?.title ?? "…") : "New conversation"}</span>
          {conversationId && <button className="btn sm ghost" onClick={() => void api(`/conversations/${conversationId}`, { method: "DELETE" }, session.token).then(() => setConversationId(null))}>Delete</button>}
        </div>
        <Chat snap={snap} conversationId={conversationId} deviceId={session.deviceId} onSend={send} onCancel={cancel} />
      </main>
      {pair && (
        <div className="modal-bg" onClick={() => setPair(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>Add a device</h3>
            <div className="small muted">Open the Android app or the web app on another device and enter this code (valid 5 minutes).</div>
            <div className="code" data-testid="pair-code">{pair.code}</div>
            <div style={{ display: "grid", placeItems: "center" }}><QRCodeSVG value={`assistant://pair?code=${pair.code}&server=${encodeURIComponent(location.origin)}`} size={160} bgColor="transparent" fgColor="currentColor" /></div>
            <button className="btn" onClick={() => setPair(null)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function timeAgo(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
