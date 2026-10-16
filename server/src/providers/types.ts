import type { Message, ToolCall } from "@assistant/protocol";

export interface JsonSchema {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}
/** Provider-facing message: the subset of Message the model needs. */
export type ChatMessage = Pick<Message, "role" | "content" | "toolCalls" | "toolCallId">;

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
}
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "toolCall"; call: ToolCall }
  | { type: "usage"; input: number; output: number }
  | { type: "done"; finishReason: "stop" | "tool_calls" | "length" | "other" };

export interface Provider {
  readonly id: string;
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly status: number | undefined, public readonly retryable: boolean) {
    super(message);
    this.name = "ProviderError";
  }
}

let n = 0;
export const newCallId = (p = "call") => `${p}_${Date.now().toString(36)}${(n = (n + 1) % 1e6).toString(36)}`;
export function safeJsonParse(s: string): Record<string, unknown> {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { _raw: s, _parseError: true };
  }
}
