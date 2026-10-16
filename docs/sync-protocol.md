# Sync protocol

Conversations are **event-sourced**. The server keeps one append-only log per
user; every change is an `Event { seq, at, body }` where `seq` increases
monotonically per user. Clients keep a cursor (the last `seq` they applied)
and a projection folded from the events; the projection function is identical
in TypeScript (`packages/protocol/src/projection.ts`) and Kotlin
(`android/core/.../Projection.kt`), and both are tested against the same
fixtures (`packages/protocol/fixtures/`).

## Why events instead of "sync the messages table"

- **Resume anywhere.** A client that reconnects says `hello{since}` and gets
  exactly the events it missed, including the `message.delta`s of a turn that
  is still streaming. No special "in-progress" state to reconcile.
- **Every device sees the same thing.** Tool calls, progress, device actions
  and their results are events too, so the laptop shows the alarm being set on
  the phone as it happens.
- **Idempotent by construction.** Applying an event with `seq <= cursor` is a
  no-op; overlapping replays and duplicate deliveries are harmless.
- **Cheap offline.** Clients queue user messages with a client-generated
  `clientMsgId`; the server deduplicates, so a retry after a crash never
  creates a second turn.

## Event types

| body.type | emitted when |
|---|---|
| `conversation.created` / `.updated` / `.deleted` | first message of a new conversation; title/archive/last-device changes; deletion |
| `message.created` | user message recorded; assistant message opened with `status: "streaming"` |
| `message.delta` | streamed text (coalesced to ~24 chars or sentence boundaries) |
| `message.completed` | status becomes `complete`, `error` or `cancelled`; carries usage |
| `tool.called` / `tool.result` | agent decided to call a tool; the outcome summary (and executing device for device tools) |
| `task.progress` | step N of M with a human label for multi-step requests |
| `device.action` / `device.action.done` | a tool that must run on a device was requested; a device finished it |

## WebSocket session

```
client                                  server
  ── connect /ws?token=JWT ───────────▶
  ◀── welcome {deviceId, serverSeq, devices}
  ── hello {since: cursor, protocol:1} ▶
  ◀── event* (replay, seq > since)
  ◀── synced {seq}                       ← client switches to live, flushes outbox, runs pending actions
  ◀── event* (live) / presence
  ── send {clientMsgId, conversationId?, text} ▶
  ◀── ack {clientMsgId, messageId, conversationId}
  ── device.result {actionId, ok, result} ▶
  ── cancel {conversationId} ▶ · ── ping ▶ ◀── pong
```

Authentication happens during the HTTP upgrade (`preValidation`), so the
socket handler is synchronous and a client's first frame can never race the
listener. Replay is paged (500 events) and live events that arrive during the
replay are buffered and delivered after it, deduplicated by `seq`.

REST mirrors the same data for clients without a socket (the Android
background worker): `GET /sync?since=`, `GET /snapshot`,
`POST /conversations/:id/messages` (idempotent on `clientMsgId`).

## Device actions

Server tools (weather, reminders, notes, calculator, fetch) run in the agent
loop. Device tools (`open_url`, `set_alarm`, `share_text`, `get_location`,
`copy_to_clipboard`, `notify`) cannot: the loop emits a `device.action`
event with the preferred `targetDeviceId` (the device that sent the message)
and awaits a `device.result` from any device of the user, with a timeout. A
device that connects later still sees the action in its projection and runs
it if it has not expired; a result for an already-settled action is rejected.
