/**
 * Deterministic provider for tests, demos and CI.  Behaves like a small agent:
 * it recognises a few intents, calls the matching tools (server and device),
 * and composes an answer from their results, streaming in word-sized deltas.
 * Nothing here is random, so e2e assertions are stable.
 */
import { newCallId, type Provider, type ProviderRequest, type StreamEvent } from "./types.js";

export class MockProvider implements Provider {
  readonly id = "mock";
  constructor(private readonly delayMs = 0) {}

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const toolResults = req.messages.filter((m) => m.role === "tool");
    const alreadyCalled = new Set(req.messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.name));
    const has = (n: string) => req.tools.some((t) => t.name === n) && !alreadyCalled.has(n);
    const text = lastUser.toLowerCase();
    const calls: StreamEvent[] = [];

    if (/weather|trip|plan/.test(text) && has("get_weather")) calls.push(tc("get_weather", { city: (text.match(/in ([a-z]+)/)?.[1] ?? "zurich").replace(/^\w/, (c) => c.toUpperCase()) }));
    if (/remind|reminder/.test(text) && has("create_reminder")) calls.push(tc("create_reminder", { text: lastUser.replace(/.*remind me to /i, ""), due_in_minutes: 60 }));
    if (/alarm|wake/.test(text) && has("set_alarm")) calls.push(tc("set_alarm", { hour: Number(text.match(/(\d{1,2})\s*(am|:)/)?.[1] ?? 7), minute: 0, label: "Assistant alarm" }));
    if (/open|show me/.test(text) && /https?:\/\/\S+/.test(lastUser) && has("open_url")) calls.push(tc("open_url", { url: lastUser.match(/https?:\/\/\S+/)![0] }));
    if (/note|save/.test(text) && has("save_note")) calls.push(tc("save_note", { title: "Note", body: lastUser }));
    if (/calculate|what is \d|\d\s*[*+/-]\s*\d/.test(text) && has("calculate")) calls.push(tc("calculate", { expression: lastUser.match(/[\d\s().*+/-]+/g)?.sort((a, b) => b.length - a.length)[0]?.trim() ?? "1+1" }));
    if (/time|date/.test(text) && has("get_time")) calls.push(tc("get_time", {}));
    if (/fail|error please/.test(text)) throw new Error("mock provider failure");

    if (calls.length) {
      for (const c of calls) { if (this.delayMs) await sleep(this.delayMs); yield c; }
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    const answer = toolResults.length
      ? `Here is what I found: ${toolResults.map((t) => summarize(t.content)).join("; ")}. Anything else?`
      : `You said: "${lastUser.trim()}". I can check the weather, set reminders and alarms, save notes, open links and do arithmetic.`;
    for (const w of answer.split(/(?<= )/)) { if (this.delayMs) await sleep(this.delayMs); yield { type: "delta", text: w }; }
    yield { type: "usage", input: Math.ceil(JSON.stringify(req.messages).length / 4), output: Math.ceil(answer.length / 4) };
    yield { type: "done", finishReason: "stop" };
  }
}
const tc = (name: string, args: Record<string, unknown>): StreamEvent => ({ type: "toolCall", call: { id: newCallId("mk"), name, arguments: args } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function summarize(json: string): string {
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (typeof v === "string") return v;
    if (v.error) return `one step failed (${String(v.error).slice(0, 80)})`;
    if ("result" in v && typeof v.result === "number") return `the result is ${v.result}`;
    if (v.place) return `${v.place}: ${v.temperature_2m}°C, wind ${v.wind_speed_10m} km/h`;
    if (v.text && v.dueAt !== undefined) return `I set a reminder "${v.text}"${v.dueAt ? ` for ${new Date(v.dueAt as number).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}`;
    if (v.iso) return `it is ${new Date(v.iso as string).toUTCString()}`;
    if (v.scheduled) return "the alarm is set on your phone";
    if (v.opened) return `I opened ${v.opened}`;
    if (v.id && typeof v.id === "string" && v.id.startsWith("note")) return "I saved the note";
    if (Array.isArray(v)) return `${v.length} item(s)`;
    return JSON.stringify(v).slice(0, 120);
  } catch { return json.slice(0, 120); }
}
