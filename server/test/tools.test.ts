import { describe, expect, it } from "vitest";
import { calculate } from "../src/tools/calc.js";
import { DeviceBroker } from "../src/tools/device-broker.js";
import { openDb } from "../src/db.js";
import { runTool, toolSpecs, type ToolRunContext } from "../src/tools/registry.js";

const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext => ({
  userId: "u", deviceId: "d", conversationId: "c", messageId: "m", db: openDb(":memory:"), now: () => 1_700_000_000_000,
  fetch: (async () => new Response("{}")) as typeof fetch,
  runOnDevice: async () => ({ ok: true, result: { done: true }, deviceId: "d" }),
  ...over,
});

describe("calculator", () => {
  it("evaluates precedence, unary minus, powers and functions without eval", () => {
    expect(calculate("1 + 2 * 3")).toBe(7);
    expect(calculate("(1 + 2) * 3")).toBe(9);
    expect(calculate("-2 ^ 2")).toBe(4); // unary binds tighter here: (-2)^2
    expect(calculate("2 ^ 3 ^ 2")).toBe(512); // right associative
    expect(calculate("sqrt(16) + abs(-3) % 2")).toBe(5);
    expect(calculate("10 / 4")).toBe(2.5);
    expect(() => calculate("1 +")).toThrow();
    expect(() => calculate("process.exit(1)")).toThrow();
    expect(() => calculate("(1 + 2")).toThrow(/parenthes/);
  });
});

describe("tool registry", () => {
  it("exports JSON schemas for every tool and validates arguments", async () => {
    const specs = toolSpecs();
    expect(specs.map((s) => s.name)).toContain("set_alarm");
    expect(specs.find((s) => s.name === "calculate")!.parameters.required).toEqual(["expression"]);
    const bad = await runTool("set_alarm", { hour: 25 }, ctx());
    expect(bad.ok).toBe(false);
    expect(bad.summary).toMatch(/invalid arguments/);
    expect((await runTool("nope", {}, ctx())).ok).toBe(false);
  });
  it("reminders and notes persist per user; notes are full-text searchable", async () => {
    const c = ctx();
    expect((await runTool("create_reminder", { text: "call mum", due_in_minutes: 30 }, c))).toMatchObject({ ok: true, summary: expect.stringContaining("call mum") });
    const list = await runTool("list_reminders", {}, c);
    expect((list.data as unknown[]).length).toBe(1);
    expect((await runTool("list_reminders", {}, { ...c, userId: "someone-else" })).data).toEqual([]);
    await runTool("save_note", { title: "Zurich trip", body: "Train at 7:30, hotel near the lake" }, c);
    await runTool("save_note", { title: "Groceries", body: "milk eggs" }, c);
    const hits = await runTool("search_notes", { query: "lake hotel" }, c);
    expect((hits.data as Array<{ title: string }>).map((h) => h.title)).toEqual(["Zurich trip"]);
  });
  it("device tools route through runOnDevice and report the executing device", async () => {
    const calls: unknown[] = [];
    const r = await runTool("set_alarm", { hour: 7, minute: 30, label: "Train" }, ctx({ runOnDevice: async (name, args) => { calls.push([name, args]); return { ok: true, result: { scheduled: true }, deviceId: "pixel" }; } }));
    expect(calls).toEqual([["set_alarm", { hour: 7, minute: 30, label: "Train" }]]);
    expect(r).toMatchObject({ ok: true, summary: "set_alarm done on pixel" });
  });
  it("weather uses Open-Meteo through the injected fetch", async () => {
    const fetchMock = (async (url: string) => new Response(JSON.stringify(url.includes("geocoding") ? { results: [{ latitude: 47.4, longitude: 8.5, name: "Zurich", country: "Switzerland" }] } : { current: { temperature_2m: 12.3, precipitation: 0.4, wind_speed_10m: 9, weather_code: 61 } }))) as unknown as typeof fetch;
    const r = await runTool("get_weather", { city: "Zurich" }, ctx({ fetch: fetchMock }));
    expect(r.summary).toBe("Zurich, Switzerland: 12.3°C, wind 9 km/h, precipitation 0.4 mm");
  });
});

describe("device broker", () => {
  it("resolves on completion and times out otherwise", async () => {
    const b = new DeviceBroker();
    const action = { id: "a1", conversationId: "c", messageId: "m", toolCallId: "t", name: "open_url" as const, arguments: {}, expiresAt: 0 };
    const p = b.wait(action, 1000);
    expect(b.complete("a1", "dev", true, { opened: true })).toBe(true);
    expect(await p).toEqual({ ok: true, result: { opened: true }, deviceId: "dev" });
    expect(b.complete("a1", "dev", true, {})).toBe(false);
    const slow = await b.wait({ ...action, id: "a2" }, 20);
    expect(slow.ok).toBe(false);
  });
});
