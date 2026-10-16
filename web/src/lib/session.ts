import { get, set, del } from "idb-keyval";
import { parse, RegisterDeviceResponse } from "@assistant/protocol";
import { api } from "./api";

export interface Session { token: string; userId: string; deviceId: string; name: string }
const KEY = "assistant.session";

export const loadSession = () => get<Session>(KEY);
export const clearSession = () => del(KEY);

export async function registerDevice(name: string, pairCode?: string): Promise<Session> {
  const r = parse(RegisterDeviceResponse, await api("/auth/device", { method: "POST", body: JSON.stringify({ name, platform: "web", pairCode }) }));
  const s = { ...r, name };
  await set(KEY, s);
  return s;
}

export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "device";
  return `${browser} on ${os}`;
}
