/** REST client. The base URL is relative in production (same origin behind the proxy) or VITE_API_URL. */
export const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function wsUrl(token: string): string {
  const base = API || `${location.protocol}//${location.host}`;
  return `${base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}
