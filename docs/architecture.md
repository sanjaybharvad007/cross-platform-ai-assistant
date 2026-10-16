# Architecture

```
  React web (PWA)                 Kotlin Android (Compose)
  SyncClient (IndexedDB)          SyncEngine (core, JVM) + Room cache + WorkManager
  browser device actions          phone device actions (alarm, share, location, ...)
        │  WebSocket + REST               │  WebSocket + REST
        └─────────────┬───────────────────┘
                      ▼
            Node.js server (Fastify 5)
            ├─ auth: device JWTs, six-digit pairing codes
            ├─ event store (SQLite via node:sqlite) + per-user fan-out
            ├─ agent runner: provider streaming, tool loop, progress, cancel
            ├─ tools: server tools · device broker (await device results)
            └─ providers: Gemini (function calling) · OpenAI-compatible · deterministic mock
                      │
                      ▼  @assistant/protocol: zod schemas + projection + fixtures
                         (mirrored in android/core, contract-tested)
```

## Repository layout

```
packages/protocol/   wire protocol (zod), projection, fixture writer, tests
server/              Fastify app: auth, db, events, agent/, providers/, tools/, ws
web/                 React 19 + Vite PWA: sync client, device actions, UI; Playwright e2e
android/             Gradle project: core (JVM) + app (Compose); see android/README.md
deploy/              Dockerfile (server + web, single origin), docker-compose
docs/                this file, sync-protocol.md, tools.md
```

## Design notes

- **One protocol package, two implementations.** The TypeScript schemas are
  the source of truth; `npm run fixtures` writes canonical JSON that the
  Kotlin `ProtocolContractTest` must parse and re-encode byte-for-byte
  (modulo key order). CI fails if the fixtures drift from the schemas.
- **The server is the only place with model keys.** Clients never call a
  model API; they send text and receive events. Switching providers is an
  environment variable.
- **Projection is pure.** The same fold runs on the server (to build
  snapshots), in the browser and on the phone. There is no client-specific
  merge logic to get wrong.
- **Deterministic mock provider.** Tests and demos run with
  `LLM_PROVIDER=mock`: it recognises intents, calls the matching tools
  (including device tools) and composes an answer from their results, so the
  whole stack is exercised end-to-end without network or keys.
- **Lifecycle-aware connectivity.** Web: `offline`/`online` events drop and
  restore the socket so sends queue instead of vanishing. Android: the socket
  lives only while the app is visible; WorkManager catches up over REST and
  notifies about replies that finished in the background.
