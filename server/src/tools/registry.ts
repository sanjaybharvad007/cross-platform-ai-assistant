/**
 * Tools the agent can call.  Server tools run here; device tools are routed
 * through the DeviceBroker to the user's connected clients.  Parameters are
 * zod schemas: exported as JSON Schema to the model, validated on the way back.
 */
import { z } from "zod";
import type { DeviceAction } from "@assistant/protocol";
import { newId, type Db } from "../db.js";
import type { ToolSpec } from "../providers/types.js";
import { calculate } from "./calc.js";
import { zodToJsonSchema } from "./schema.js";

export interface ToolRunContext {
  userId: string;
  deviceId: string;
  conversationId: string;
  messageId: string;
  db: Db;
  /** Route a device action and await the result. */
  runOnDevice(name: DeviceAction["name"], args: Record<string, unknown>, targetDeviceId?: string): Promise<{ ok: boolean; result: unknown; deviceId: string }>;
  fetch: typeof fetch;
  now(): number;
}
export interface ToolResult { ok: boolean; data: unknown; summary: string }
export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  executor: "server" | "device";
  run(args: z.infer<S>, ctx: ToolRunContext): Promise<ToolResult>;
}
const tool = <S extends z.ZodTypeAny>(t: Tool<S>): Tool<S> => t;
const device = (name: DeviceAction["name"], description: string, schema: z.ZodTypeAny) =>
  tool({
    name, description, schema, executor: "device",
    async run(args, ctx) {
      const r = await ctx.runOnDevice(name, args as Record<string, unknown>);
      return { ok: r.ok, data: r.result, summary: r.ok ? `${name} done on ${r.deviceId}` : `${name} failed: ${(r.result as { error?: string })?.error ?? "unknown"}` };
    },
  });

export const TOOLS: readonly Tool[] = [
  tool({
    name: "get_time", description: "Current date and time (UTC ISO string and epoch ms).", schema: z.object({}), executor: "server",
    async run(_a, ctx) { const t = ctx.now(); return { ok: true, data: { iso: new Date(t).toISOString(), epochMs: t }, summary: new Date(t).toISOString() }; },
  }),
  tool({
    name: "calculate", description: "Evaluate an arithmetic expression (+ - * / % ^, parentheses, sqrt/abs/round/ln/log/sin/cos/tan).",
    schema: z.object({ expression: z.string().describe("e.g. (12.5 * 4) / 3") }), executor: "server",
    async run(a) { try { const v = calculate(a.expression); return { ok: true, data: { result: v }, summary: `${a.expression} = ${v}` }; } catch (e) { return { ok: false, data: { error: (e as Error).message }, summary: (e as Error).message }; } },
  }),
  tool({
    name: "get_weather", description: "Current weather for a city (Open-Meteo, no key needed).", schema: z.object({ city: z.string() }), executor: "server",
    async run(a, ctx) {
      const geo = await (await ctx.fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(a.city)}&count=1`)).json() as { results?: Array<{ latitude: number; longitude: number; name: string; country: string }> };
      const g = geo.results?.[0];
      if (!g) return { ok: false, data: { error: "city not found" }, summary: `no match for ${a.city}` };
      const w = await (await ctx.fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m,precipitation,wind_speed_10m,weather_code`)).json() as { current?: { temperature_2m: number; precipitation: number; wind_speed_10m: number; weather_code: number } };
      const c = w.current;
      if (!c) return { ok: false, data: w, summary: "no weather data" };
      const summary = `${g.name}, ${g.country}: ${c.temperature_2m}°C, wind ${c.wind_speed_10m} km/h, precipitation ${c.precipitation} mm`;
      return { ok: true, data: { ...c, place: `${g.name}, ${g.country}` }, summary };
    },
  }),
  tool({
    name: "create_reminder", description: "Create a reminder for the user.",
    schema: z.object({ text: z.string(), due_in_minutes: z.number().int().positive().optional(), due_at_iso: z.string().optional() }), executor: "server",
    async run(a, ctx) {
      const due = a.due_at_iso ? Date.parse(a.due_at_iso) : a.due_in_minutes ? ctx.now() + a.due_in_minutes * 60_000 : null;
      const id = newId("rem");
      ctx.db.prepare("INSERT INTO reminders(id, user_id, text, due_at, done, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(id, ctx.userId, a.text, due, ctx.now());
      return { ok: true, data: { id, text: a.text, dueAt: due }, summary: `reminder "${a.text}"${due ? ` at ${new Date(due).toISOString()}` : ""}` };
    },
  }),
  tool({
    name: "list_reminders", description: "List the user's open reminders.", schema: z.object({}), executor: "server",
    async run(_a, ctx) {
      const rows = ctx.db.prepare("SELECT id, text, due_at FROM reminders WHERE user_id = ? AND done = 0 ORDER BY COALESCE(due_at, 9e15)").all(ctx.userId) as Array<{ id: string; text: string; due_at: number | null }>;
      return { ok: true, data: rows, summary: `${rows.length} open reminder(s)` };
    },
  }),
  tool({
    name: "save_note", description: "Save a note (title + body) to the user's notebook.", schema: z.object({ title: z.string(), body: z.string() }), executor: "server",
    async run(a, ctx) { const id = newId("note"); ctx.db.prepare("INSERT INTO notes(id, user_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, ctx.userId, a.title, a.body, ctx.now(), ctx.now()); return { ok: true, data: { id }, summary: `saved note "${a.title}"` }; },
  }),
  tool({
    name: "search_notes", description: "Full-text search over the user's notes.", schema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).default(5) }), executor: "server",
    async run(a, ctx) {
      const q = a.query.replace(/["*]/g, " ").trim().split(/\s+/).filter(Boolean).map((t) => `"${t}"`).join(" OR ");
      if (!q) return { ok: true, data: [], summary: "empty query" };
      const rows = ctx.db.prepare("SELECT n.id, n.title, snippet(notes_fts, 1, '[', ']', '…', 12) AS snippet FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? AND n.user_id = ? ORDER BY rank LIMIT ?").all(q, ctx.userId, a.limit) as Array<{ id: string; title: string; snippet: string }>;
      return { ok: true, data: rows, summary: `${rows.length} note(s) match "${a.query}"` };
    },
  }),
  tool({
    name: "fetch_url", description: "Fetch a web page and return its readable text (first 6000 characters).", schema: z.object({ url: z.string().url() }), executor: "server",
    async run(a, ctx) {
      if (!/^https?:/i.test(a.url)) return { ok: false, data: null, summary: "only http(s)" };
      const res = await ctx.fetch(a.url, { headers: { accept: "text/html,text/plain" }, signal: AbortSignal.timeout(10_000) });
      const html = await res.text();
      const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 6000);
      return { ok: res.ok, data: { status: res.status, text }, summary: `${res.status} ${a.url} (${text.length} chars)` };
    },
  }),
  device("open_url", "Open a URL on the user's device (new tab / browser).", z.object({ url: z.string().url() })),
  device("set_alarm", "Set an alarm on the user's phone.", z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59).default(0), label: z.string().optional() })),
  device("share_text", "Open the device share sheet with text.", z.object({ text: z.string() })),
  device("get_location", "Ask the device for its current GPS location (user is prompted).", z.object({})),
  device("copy_to_clipboard", "Copy text to the device clipboard.", z.object({ text: z.string() })),
  device("notify", "Show a notification on the user's device.", z.object({ title: z.string(), body: z.string() })),
];

export const toolSpecs = (): ToolSpec[] => TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: zodToJsonSchema(t.schema) }));
export const executorOf = (name: string) => TOOLS.find((t) => t.name === name)?.executor ?? "server";

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { ok: false, data: null, summary: `unknown tool ${name}` };
  const p = t.schema.safeParse(args);
  if (!p.success) return { ok: false, data: { error: p.error.issues }, summary: `invalid arguments for ${name}: ${p.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ")}` };
  try { return await t.run(p.data, ctx); } catch (e) { return { ok: false, data: { error: String(e) }, summary: `${name} failed: ${(e as Error).message}` }; }
}
