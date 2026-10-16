import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@assistant/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)) } },
  test: {
    include: ["packages/**/*.test.ts", "server/**/*.test.ts", "web/src/**/*.test.ts", "web/src/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [["web/src/**", "jsdom"]],
    testTimeout: 15_000,
  },
});
