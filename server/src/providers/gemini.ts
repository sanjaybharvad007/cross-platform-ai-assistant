/** Google Gemini: SSE streaming with native function calling. */
import { fetchWithRetry } from "./retry.js";
import { parseSse } from "./sse.js";
import { newCallId, ProviderError, type ChatMessage, type Provider, type ProviderRequest, type StreamEvent, type ToolSpec } from "./types.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
type Part = { text: string } | { functionCall: { name: string; args: Record<string, unknown> } } | { functionResponse: { name: string; response: Record<string, unknown> } };

export function toGeminiContents(messages: ChatMessage[]) {
  const out: Array<{ role: "user" | "model"; parts: Part[] }> = [];
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) { names.set(c.id, c.name); parts.push({ functionCall: { name: c.name, args: c.arguments } }); }
      if (parts.length) out.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const part: Part = { functionResponse: { name: names.get(m.toolCallId ?? "") ?? "tool", response: { result: tryJson(m.content) } } };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.parts[0] && "functionResponse" in last.parts[0]) last.parts.push(part);
      else out.push({ role: "user", parts: [part] });
    } else out.push({ role: "user", parts: [{ text: m.content }] });
  }
  return out;
}
const tryJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

export class GeminiProvider implements Provider {
  readonly id = "gemini";
  constructor(private readonly apiKey: string, private readonly fetchImpl = fetchWithRetry) {}
  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    if (!this.apiKey) throw new ProviderError("GEMINI_API_KEY is not set", 401, false);
    const body = {
      systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
      contents: toGeminiContents(req.messages),
      tools: req.tools.length ? [{ functionDeclarations: req.tools.map((t: ToolSpec) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] : undefined,
      generationConfig: { temperature: req.temperature, maxOutputTokens: req.maxOutputTokens ?? 2048 },
    };
    const res = await this.fetchImpl(`${BASE}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey }, body: JSON.stringify(body),
    }, { signal: req.signal });
    if (!res.body) throw new ProviderError("empty body", res.status, true);
    let tool = false;
    let finish: "stop" | "length" | "other" = "stop";
    for await (const ev of parseSse(res.body, req.signal)) {
      let j: { candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }; error?: { code?: number; message?: string } };
      try { j = JSON.parse(ev.data); } catch { continue; }
      if (j.error) throw new ProviderError(j.error.message ?? "Gemini error", j.error.code, false);
      const c = j.candidates?.[0];
      for (const p of c?.content?.parts ?? []) {
        if ("text" in p && p.text) yield { type: "delta", text: p.text };
        if ("functionCall" in p) { tool = true; yield { type: "toolCall", call: { id: newCallId("gm"), name: p.functionCall.name, arguments: p.functionCall.args ?? {} } }; }
      }
      if (c?.finishReason === "MAX_TOKENS") finish = "length";
      if (j.usageMetadata) yield { type: "usage", input: j.usageMetadata.promptTokenCount ?? 0, output: j.usageMetadata.candidatesTokenCount ?? 0 };
    }
    yield { type: "done", finishReason: tool ? "tool_calls" : finish };
  }
}
