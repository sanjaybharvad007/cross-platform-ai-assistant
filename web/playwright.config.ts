import { defineConfig } from "@playwright/test";

const API = 8790;
const WEB = 5174;
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${WEB}`, trace: "retain-on-failure", ...(process.env.CHROME_PATH ? { launchOptions: { executablePath: process.env.CHROME_PATH } } : {}) },
  webServer: [
    { command: `npx tsx ../server/src/main.ts`, port: API, reuseExistingServer: false, env: { PORT: String(API), DATABASE_PATH: ":memory:", LLM_PROVIDER: "mock", MOCK_DELAY_MS: "25", LOG_LEVEL: "warn", DEVICE_ACTION_TIMEOUT_MS: "8000" } },
    { command: `npx vite --port ${WEB} --strictPort`, port: WEB, reuseExistingServer: false, env: { API_TARGET: `http://127.0.0.1:${API}` } },
  ],
});
