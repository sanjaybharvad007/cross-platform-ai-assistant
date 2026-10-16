import type { Config } from "../config.js";
import { GeminiProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";
import { OpenAiProvider } from "./openai.js";
import type { Provider } from "./types.js";

export function createProvider(cfg: Config): Provider {
  switch (cfg.LLM_PROVIDER) {
    case "gemini": return new GeminiProvider(cfg.GEMINI_API_KEY);
    case "openai": return new OpenAiProvider(cfg.OPENAI_API_KEY, cfg.OPENAI_BASE_URL);
    case "mock": return new MockProvider(Number(process.env.MOCK_DELAY_MS ?? 0));
  }
}
export * from "./types.js";
