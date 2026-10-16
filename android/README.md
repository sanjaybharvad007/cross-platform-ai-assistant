# Android client

Kotlin, Jetpack Compose, Room, OkHttp WebSocket, WorkManager, kotlinx.serialization.

```
core/   pure Kotlin (JVM): protocol models mirroring @assistant/protocol, the event projection,
        and the transport-agnostic SyncEngine (cursor, outbox, device actions) - unit-tested,
        contract-tested against ../packages/protocol/fixtures
app/    the Android app: Compose UI, Room cache of the projection, WebSocket + REST transport,
        WorkManager background sync, device tools (alarms, share, clipboard, notifications, location)
```

## Build

```bash
./gradlew :core:test            # JVM tests incl. the protocol contract test
./gradlew :app:assembleDebug    # needs the Android SDK (ANDROID_HOME) - CI runs this
```

The debug build talks to `http://10.0.2.2:8787` (the host machine from an emulator); change the
server URL on the onboarding screen for a real device. Pair with a six-digit code from the web
app's **Add device** dialog, or scan its QR code (`assistant://pair?code=...&server=...`).

## How sync works on the phone

1. On launch the Room cache (conversations, messages, cursor, outbox) is loaded into a `SyncEngine`
   so the UI renders instantly, offline.
2. While the app is in the foreground an OkHttp WebSocket connects; the engine answers the server's
   `welcome` with `hello{since: cursor}`, replays missed events, then streams live. Every event is
   folded into the projection and written back to Room.
3. Messages typed offline go to the outbox with a client-generated idempotency key and are flushed
   on the next `synced`; the server deduplicates retries.
4. `device.action` events addressed to this phone are executed (`AlarmClock.ACTION_SET_ALARM`,
   `ACTION_SEND`, clipboard, notification, `LocationManager`) and the result is sent back, so the
   agent loop on the server - and the laptop watching the same conversation - sees the outcome.
5. In the background a periodic WorkManager job catches up over REST (`GET /sync?since=`), pushes
   the outbox, and posts a notification when a reply finished while the app was closed.
