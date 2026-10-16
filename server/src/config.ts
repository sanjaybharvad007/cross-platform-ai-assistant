import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_PATH: z.string().default("./data/assistant.db"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-me-please-32chars"),
  LLM_PROVIDER: z.enum(["gemini", "openai", "mock"]).default("mock"),
  LLM_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  MAX_TOOL_STEPS: z.coerce.number().int().min(0).max(20).default(8),
  DEVICE_ACTION_TIMEOUT_MS: z.coerce.number().int().default(45_000),
  CORS_ORIGIN: z.string().default("*"),
  LOG_LEVEL: z.string().default("info"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(120),
  /** Serve the built web app from this directory (single-origin deployment). */
  STATIC_DIR: z.string().default(""),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
