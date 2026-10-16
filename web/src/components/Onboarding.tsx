import { useState } from "react";
import { defaultDeviceName, registerDevice, type Session } from "../lib/session";

export function Onboarding({ onDone }: { onDone: (s: Session) => void }) {
  const [name, setName] = useState(defaultDeviceName());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (pair: boolean) => {
    setBusy(true); setErr(null);
    try { onDone(await registerDevice(name, pair ? code : undefined)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="onboard">
      <form className="card" onSubmit={(e) => { e.preventDefault(); void go(code.length === 6); }}>
        <div className="row"><img src="/icon.svg" width={28} height={28} alt="" /><h1>Assistant</h1></div>
        <p className="muted small" style={{ margin: 0 }}>One assistant across your browser and your phone. Conversations, tool results and tasks stay in sync; pick up on any device where you left off.</p>
        <label>This device<input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Pairing code from another device (optional)<input className="input" inputMode="numeric" pattern="\d{6}" placeholder="6 digits" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
        {err && <div className="small" style={{ color: "var(--err)" }}>{err}</div>}
        <button className="btn primary" disabled={busy || !name.trim() || (code.length > 0 && code.length !== 6)}>{code.length === 6 ? "Join with code" : "Start"}</button>
      </form>
    </div>
  );
}
