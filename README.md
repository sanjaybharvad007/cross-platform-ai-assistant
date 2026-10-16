# Cross-Platform AI Assistant

**One assistant across a React web app and a Kotlin Android app, backed by a Node.js agent service: LLM tool calling that acts on the server and on the user's devices, and event-sourced conversations that stay in sync across devices — including resuming a reply that is still streaming.**

[![CI](https://github.com/sanjaybharvad007/cross-platform-ai-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjaybharvad007/cross-platform-ai-assistant/actions/workflows/ci.yml)
[![Android](https://github.com/sanjaybharvad007/cross-platform-ai-assistant/actions/workflows/android.yml/badge.svg)](https://github.com/sanjaybharvad007/cross-platform-ai-assistant/actions/workflows/android.yml)
![Node](https://img.shields.io/badge/Node.js-22%20%7C%20Fastify%205-339933)
![React](https://img.shields.io/badge/React-19%20%7C%20PWA-61DAFB)
![Kotlin](https://img.shields.io/badge/Kotlin-2.0%20%7C%20Compose-7F52FF)
![Gemini](https://img.shields.io/badge/Gemini-function%20calling-8E75B2)
![Tests](https://img.shields.io/badge/tests-25%20unit%20%2B%202%20e2e%20%2B%20Kotlin%20contract-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

```
laptop (web):  "Plan a weekend trip to Zurich and set an alarm for the 7:30 train"
                 ├ get_weather        Zurich: 12°C, light rain
                 ├ set_alarm ──────── routed to the phone ──▶ alarm set on Pixel 8
                 └ Day 1: Old Town and the lake. ...                 ← streamed to both devices
phone (android): opens the same conversation, sees every step, continues the thread
```

---

## Contents

- [Highlights](#highlights)
- [Architecture](#architecture)
- [Features](#features)
- [Quick start](#quick-start)
- [Design](#design)
- [Testing](#testing)
- [Deployment](#deployment)
- [Repository layout](#repository-layout)
- [Roadmap](#roadmap)
- [References](#references)

---

## Highlights

- **Event-sourced conversations.** Every change — message, streamed delta, tool call, progress, device action, completion — is an immutable event with a per-user sequence number. Clients resume from a cursor and converge on identical state; a reload in the middle of a streaming reply picks up exactly where it stopped.
- **One projection, two languages.** The fold from events to UI state is implemented in TypeScript and Kotlin and both are tested against the same JSON fixtures that CI regenerates from the schemas.
- **Tool calling that reaches the device.** Server tools (weather, reminders, FTS-searchable notes, calculator, page fetch) plus **device tools** — set an alarm, open a URL, share, clipboard, notification, location — routed to the user's phone or browser and awaited by the agent loop.
- **Multi-step tasks with progress.** The runner streams text, executes tools, feeds results back and emits `task.progress` events, up to a step budget; cancel from any device.
- **Device pairing without accounts.** A device registers and gets a JWT; other devices join with a six-digit code or by scanning a QR deep link (`assistant://pair?...`).
- **Works offline.** Web: IndexedDB cache + outbox flushed on reconnect, PWA. Android: Room cache, outbox, WorkManager background catch-up with notifications.
- **Providers behind one interface.** Google Gemini (native function calling), OpenAI-compatible (OpenAI, Ollama, vLLM), and a deterministic mock used by every test.
- **Verified end to end.** Server unit tests, WebSocket integration tests (three clients converging mid-stream), and Playwright tests that drive two browser contexts as two paired devices against the real server.

## Architecture

```
  React web (PWA)                       Kotlin Android (Compose)
  SyncClient · IndexedDB · outbox        SyncEngine (core/JVM) · Room · WorkManager
  browser device actions                 phone device actions
        │  WebSocket + REST                      │  WebSocket + REST
        └───────────────────┬────────────────────┘
                            ▼
                 Node.js server (Fastify 5, TypeScript)
                 auth (device JWT, pairing) · event store (node:sqlite, WAL) · fan-out
                 agent runner (stream → tools → progress → complete, cancel)
                 tools: server · device broker        providers: Gemini · OpenAI-compat · mock
                            │
              @assistant/protocol — zod schemas, projection, fixtures (mirrored in android/core)
```

Details: [`docs/architecture.md`](docs/architecture.md), [`docs/sync-protocol.md`](docs/sync-protocol.md), [`docs/tools.md`](docs/tools.md), [`android/README.md`](android/README.md).

## Features

| Area | What | Where |
|---|---|---|
| Protocol | zod-validated events, WS frames, REST shapes; pure projection; fixture writer | `packages/protocol/` |
| Event store | per-user monotonic `seq`, transactional projections, paged replay, in-process pub/sub, snapshots | `server/src/events.ts`, `db.ts` |
| Auth | device registration → HS256 JWT (jose); single-use six-digit pairing codes; presence | `server/src/auth.ts` |
| Agent | streaming loop, tool execution, `task.progress`, idempotent sends by `clientMsgId`, cancel, error states | `server/src/agent/runner.ts` |
| Tools | zod → JSON Schema, re-validation, server tools, device broker with timeouts | `server/src/tools/` |
| Providers | Gemini SSE + function calling; OpenAI-compatible fragmented tool calls; retry with jittered backoff; mock | `server/src/providers/` |
| Transport | WebSocket `hello/since` resume with buffered live events; REST `/sync`, `/snapshot`, idempotent `POST /messages` | `server/src/ws.ts`, `app.ts` |
| Web | sync client with cursor, outbox and offline handling; chat with streaming, tool cards, progress, device attribution, "continue here" banner; pairing dialog with QR; PWA | `web/src/` |
| Android | `core` (protocol, projection, SyncEngine) + Compose app with Room, OkHttp WebSocket, WorkManager, device tools, deep-link pairing | `android/` |
| Ops | Dockerfile serving API + web from one origin, compose file, health endpoint, rate limiting, structured logs | `deploy/` |

## Quick start

```bash
git clone https://github.com/sanjaybharvad007/cross-platform-ai-assistant
cd cross-platform-ai-assistant
npm ci
cp .env.example .env            # set LLM_PROVIDER=gemini and GEMINI_API_KEY, or leave mock
npm run dev                     # server on :8787, web on :5173 (proxied)
```

Open http://localhost:5173, name the device, start chatting. Click **Add device** to get a pairing code, then open the same URL in another browser (or the Android app) and join with the code: both devices show the same conversations live.

Android: open `android/` in Android Studio, run on an emulator (the debug build points at the host's `:8787`), pair with a code or the QR link.

Try: *"What's the weather in Zurich?"*, *"Remind me to call the dentist in an hour"*, *"Set an alarm for 7am on my phone"*, *"Save a note: ideas for the weekend"*, *"What is 1250 × 1.08?"*.

## Design

### Why event sourcing

Synchronising "the messages table" between devices breaks down exactly where it matters: a reply that is still streaming, a tool call that is waiting for a phone, a message typed offline. With an append-only log the server has one answer for every client — *here is what happened after seq N* — and the client has one operation — *fold it*. Resume, multi-device live view, idempotent retries and offline queues all fall out of that single decision. [`docs/sync-protocol.md`](docs/sync-protocol.md) walks through the frames.

### Device tools close the loop

A model that can only talk is not an assistant. Tool calls the server cannot perform are turned into `device.action` events addressed to the device that asked (any online device may fulfil them); the agent loop awaits the result with a timeout and continues with it, so *"set an alarm for the train and tell me the weather"* is one request, two executors, one answer — visible on every device.

### Correctness over cleverness

- Auth happens during the WebSocket upgrade so the first frame cannot race the handler (a bug the e2e suite caught).
- Live events arriving during a replay are buffered and emitted after it, deduplicated by `seq`.
- Client-generated idempotency keys mean a retry after a crash never duplicates a turn.
- The projection is pure and shared; there is no bespoke merge logic per client.
- The browser drops its socket on the `offline` event so sends queue instead of vanishing into a half-open connection.

## Testing

```bash
npm test                   # 25 unit/integration tests: protocol + projection, event store, auth, tools,
                           # agent runner (mock provider), WebSocket sync (3 clients converge mid-stream)
npm run e2e                # Playwright: two browser contexts = two paired devices against the real server
cd android && ./gradlew :core:test   # Kotlin: protocol contract test against the shared fixtures, SyncEngine tests
```

The Playwright suite proves the cross-device story in a real browser: pair by code, both devices see the same history, a message sent from the "phone" streams live on the "laptop" with device attribution, a reload mid-stream converges to the same text, `open_url` runs in the browser and reports back, and an offline send is queued and delivered on reconnect.

## Deployment

```bash
docker compose -f deploy/docker-compose.yml up --build      # API + web on :8787, SQLite volume
```

Environment: `LLM_PROVIDER`, `LLM_MODEL`, `GEMINI_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL`, `JWT_SECRET`, `DATABASE_PATH`, `MAX_TOOL_STEPS`, `DEVICE_ACTION_TIMEOUT_MS`, `CORS_ORIGIN`, `STATIC_DIR`. The server is a single process with SQLite in WAL mode; for horizontal scale, the event fan-out is the one component to replace (Redis pub/sub) — everything else is stateless per request.

## Repository layout

```
packages/protocol/src     index.ts (schemas)  projection.ts  protocol.test.ts   scripts/write-fixtures.ts   fixtures/
server/src                app.ts  main.ts  config.ts  db.ts  events.ts  auth.ts  ws.ts
                          agent/runner.ts   tools/{registry,device-broker,calc,schema}.ts   providers/{gemini,openai,mock,sse,retry}.ts
server/test               store · tools · runner · ws (helpers.ts)
web/src                   App.tsx  components/{Chat,Onboarding}.tsx  lib/{sync,api,session,device-actions}.ts   e2e/sync.spec.ts
android/core              Protocol.kt  Projection.kt  SyncEngine.kt  + tests
android/app               AssistantApp · data/{Prefs,local/AppDatabase,remote/ApiClient} · sync/{SyncRepository,SyncWorker} · device/DeviceActions · ui/
deploy/  docs/  .github/workflows/{ci,android}.yml
```

## Roadmap

- iOS client (Swift, sharing the same protocol and fixtures)
- Voice input/output on Android and web
- Redis-backed fan-out and Postgres event store for multi-instance deployments
- Tool permissions per device (e.g. no `open_url` on a shared screen)
- Scheduled and proactive tasks (reminders that fire a tool on the right device)

## References

- Fowler, M. *Event Sourcing.* martinfowler.com, 2005.
- Kleppmann, M. *Designing Data-Intensive Applications*, ch. 11 (stream processing and logs). 2017.
- Google AI for Developers. *Gemini API: function calling*, *streaming with `alt=sse`*.
- Schick, T. et al. *Toolformer: Language Models Can Teach Themselves to Use Tools.* 2023.
- Android Developers. *WorkManager*, *Room*, *App Links and deep links*, *AlarmClock intents*.

## License

MIT. See [LICENSE](LICENSE).
