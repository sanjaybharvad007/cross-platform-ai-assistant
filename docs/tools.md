# Tools

Every tool declares its parameters as a zod schema (`server/src/tools/registry.ts`).
The schema is exported as JSON Schema to the model and re-applied to the
model's arguments before anything runs; invalid calls return a structured
error the model can correct.

| Tool | Executor | What it does |
|---|---|---|
| `get_time` | server | ISO + epoch time |
| `calculate` | server | shunting-yard evaluator (`+ - * / % ^`, functions); no `eval` |
| `get_weather` | server | Open-Meteo geocoding + current conditions, no API key |
| `create_reminder` / `list_reminders` | server | per-user reminders in SQLite |
| `save_note` / `search_notes` | server | notes with SQLite FTS5 full-text search |
| `fetch_url` | server | fetch a page, strip tags, return readable text |
| `open_url` | device | browser: `window.open`; Android: `ACTION_VIEW` |
| `set_alarm` | device | Android: `AlarmClock.ACTION_SET_ALARM` (browser declines so the phone takes it) |
| `share_text` | device | Web Share API / `ACTION_SEND` chooser |
| `copy_to_clipboard` | device | clipboard API / `ClipboardManager` |
| `notify` | device | Notifications API / `NotificationCompat` |
| `get_location` | device | Geolocation API / `LocationManager` (user is prompted) |

Device tools go through the `DeviceBroker`: the agent emits a `device.action`
event and awaits the first `device.result` (default timeout 45 s). The result
becomes the tool message the model sees next, and `device.action.done` tells
every client who performed it.

## Adding a tool

```ts
tool({
  name: "translate", description: "Translate text", executor: "server",
  schema: z.object({ text: z.string(), to: z.string().describe("BCP-47 code") }),
  async run(a, ctx) { /* ... */ return { ok: true, data: { text: out }, summary: `translated to ${a.to}` }; },
})
```

Add it to `TOOLS`, give it a label in `labelFor` (progress text), and - if it
should run on a device - a handler in `web/src/lib/device-actions.ts` and
`android/app/.../DeviceActions.kt`.
