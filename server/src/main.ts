import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const cfg = loadConfig();
const app = await buildApp({ cfg });
await app.listen({ port: cfg.PORT, host: cfg.HOST });
app.log.info({ provider: cfg.LLM_PROVIDER, model: cfg.LLM_MODEL, db: cfg.DATABASE_PATH }, "assistant server up");
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { app.log.info("shutting down"); void app.close().then(() => process.exit(0)); });
