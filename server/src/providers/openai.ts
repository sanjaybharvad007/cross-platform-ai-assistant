/** OpenAI-compatible chat completions (OpenAI, Ollama, vLLM, LM Studio). */
import { fetchWithRetry } from "./retry.js";
import { parseSse } from "./sse.js";
import { newCallId, ProviderError, safeJsonParse, type ChatMessage, type Provider, type ProviderRequest, type StreamEvent } from "./types.js";

export function toOpenAiMessages(system: string, messages: ChatMessage[]) {
  const out: Array<Record<string, unknown>> = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") out.push({ role: "assistant", content: m.content || null, tool_calls: m.toolCalls?.length ? m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) : undefined });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    else out.push({ role: "user", content: m.content });
  }
  return out;
}

export class OpenAiProvider implements Provider {
  readonly id = "openai";
  constructor(private readonly apiKey: string, private readonly baseUrl: string, private readonly fetchImpl = fetchWithRetry) {}
  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: req.model, messages: toOpenAiMessages(req.system, req.messages), temperature: req.temperature, max_tokens: req.maxOutputTokens, stream: true, stream_options: { include_usage: true },
        tools: req.tools.length ? req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
      }),
    }, { signal: req.signal });
    if (!res.body) throw new ProviderError("empty body", res.status, true);
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: "stop" | "tool_calls" | "length" | "other" = "stop";
    for await (const ev of parseSse(res.body, req.signal)) {
      if (ev.data === "[DONE]") break;
      let j: { choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>; usage?: { prompt_tokens?: number; completion_tokens?: number } | null; error?: { message?: string } };
      try { j = JSON.parse(ev.data); } catch { continue; }
      if (j.error) throw new ProviderError(j.error.message ?? "error", undefined, false);
      const ch = j.choices?.[0];
      if (ch?.delta?.content) yield { type: "delta", text: ch.delta.content };
      for (const tc of ch?.delta?.tool_calls ?? []) {
        const slot = pending.get(tc.index) ?? { id: tc.id ?? newCallId("oa"), name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        slot.name += tc.function?.name ?? "";
        slot.args += tc.function?.arguments ?? "";
        pending.set(tc.index, slot);
      }
      if (ch?.finish_reason) finish = ch.finish_reason === "tool_calls" ? "tool_calls" : ch.finish_reason === "length" ? "length" : ch.finish_reason === "stop" ? "stop" : "other";
      if (j.usage) yield { type: "usage", input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 };
    }
    for (const [, s] of [...pending.entries()].sort((a, b) => a[0] - b[0])) { yield { type: "toolCall", call: { id: s.id, name: s.name, arguments: safeJsonParse(s.args) } }; finish = "tool_calls"; }
    yield { type: "done", finishReason: finish };
  }
}
