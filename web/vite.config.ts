import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

const proxyTo = (target: string) => ({
  "/ws": { target: target.replace(/^http/, "ws"), ws: true },
  ...Object.fromEntries(["/auth", "/sync", "/snapshot", "/conversations", "/me", "/health"].map((p) => [p, target])),
});

export default defineConfig({
  resolve: { alias: { "@assistant/protocol": fileURLToPath(new URL("../packages/protocol/src/index.ts", import.meta.url)) } },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: { name: "Assistant", short_name: "Assistant", theme_color: "#111318", background_color: "#111318", display: "standalone", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }] },
      workbox: { navigateFallbackDenylist: [/^\/ws/, /^\/auth/, /^\/sync/, /^\/snapshot/, /^\/conversations/] },
    }),
  ],
  server: { port: 5173, proxy: proxyTo(process.env.API_TARGET ?? "http://localhost:8787") },
  preview: { port: 4173 },
  build: { target: "es2022", sourcemap: true },
});
