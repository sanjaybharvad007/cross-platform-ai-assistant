import { ProviderError } from "./types.js";

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const isRetryable = (s: number) => s === 408 || s === 409 || s === 429 || (s >= 500 && s < 600);

export function retryDelayMs(attempt: number, retryAfter: string | null, base = 500, max = 8000): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(max, secs * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(max, Math.max(0, at - Date.now()));
  }
  const exp = base * 2 ** attempt;
  return Math.min(max, exp / 2 + Math.random() * exp);
}

export async function fetchWithRetry(url: string, init: RequestInit, opts: { retries?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? sleepDefault;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const res = await fetch(url, { ...init, signal: opts.signal });
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      const err = new ProviderError(`HTTP ${res.status}: ${summarize(text)}`, res.status, isRetryable(res.status));
      if (!err.retryable || attempt === retries) throw err;
      last = err;
      await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
    } catch (e) {
      if (e instanceof ProviderError) { if (!e.retryable || attempt === retries) throw e; last = e; }
      else if ((e as Error).name === "AbortError") throw e;
      else { last = new ProviderError(`network error: ${(e as Error).message}`, undefined, true); if (attempt === retries) throw last; await sleep(retryDelayMs(attempt, null)); }
    }
  }
  throw last;
}
const summarize = (t: string) => { try { const j = JSON.parse(t); return j?.error?.message ?? j?.message ?? t.slice(0, 200); } catch { return t.slice(0, 200); } };
