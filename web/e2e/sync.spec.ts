/**
 * Cross-device e2e: two browser contexts act as two devices of one user
 * (paired by code) against the real server with the deterministic mock model.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

async function onboard(browser: Browser, name: string, pairCode?: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByLabel("This device").fill(name);
  if (pairCode) await page.getByLabel(/Pairing code/).fill(pairCode);
  await page.getByRole("button", { name: pairCode ? "Join with code" : "Start" }).click();
  await expect(page.getByTestId("conn")).toHaveText(/live/);
  return page;
}

test("one user, two devices: paired history, live streaming on both, resume after reload", async ({ browser }) => {
  const a = await onboard(browser, "Chrome on Mac");
  await a.getByTestId("composer").fill("What is 12 * 12?");
  await a.getByTestId("send").click();
  await expect(a.getByTestId("user-msg")).toHaveText(/12 \* 12/);
  const answer = a.getByTestId("assistant-msg");
  await expect(answer).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
  await expect(answer).toContainText("144");
  await expect(a.getByTestId("tool-card")).toContainText("calculate");
  await expect(a.getByTestId("conversations")).toContainText("What is 12 * 12?");

  // pair a second device with a code from the first
  await a.getByTestId("pair").click();
  const code = (await a.getByTestId("pair-code").textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);
  await a.getByRole("button", { name: "Done" }).click();
  const b = await onboard(browser, "Pixel 8", code);
  await expect(b.getByTestId("conversations")).toContainText("What is 12 * 12?");
  await expect(b.getByTestId("device")).toHaveCount(2);
  await expect(a.getByTestId("device")).toHaveCount(2);
  await expect(a.getByTestId("device").filter({ hasText: "Pixel 8" })).toContainText("online");

  // B continues the conversation; A sees the user message and the stream live, attributed to the phone
  await b.getByTestId("conversations").getByRole("button").first().click();
  await b.getByTestId("composer").fill("remind me to buy milk");
  await b.getByTestId("send").click();
  await expect(a.getByTestId("user-msg").nth(1)).toContainText("buy milk");
  await expect(a.getByTestId("user-msg").nth(1)).toContainText("from Pixel 8");
  await expect(a.getByTestId("tool-card").filter({ hasText: "create_reminder" })).toContainText("reminder", { timeout: 20_000 });
  await expect(a.getByTestId("assistant-msg").nth(1)).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
  const finalText = await a.getByTestId("assistant-msg").nth(1).locator(".body").textContent();
  expect(finalText).toMatch(/buy milk/);

  // A reloads in the middle of a new streaming turn and converges to the same state as B
  await a.getByTestId("composer").fill("tell me something long about the city of Zurich please");
  await a.getByTestId("send").click();
  await expect(a.getByTestId("assistant-msg").nth(2)).toHaveAttribute("data-status", "streaming");
  await a.reload();
  await expect(a.getByTestId("conn")).toHaveText(/live/);
  await expect(a.getByTestId("assistant-msg").nth(2)).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
  await expect(b.getByTestId("assistant-msg").nth(2)).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
  const [ta, tb] = await Promise.all([a.getByTestId("assistant-msg").nth(2).locator(".body").textContent(), b.getByTestId("assistant-msg").nth(2).locator(".body").textContent()]);
  expect(ta).toBe(tb);
  expect(ta!.length).toBeGreaterThan(20);
  await expect(b.locator(".continue")).toContainText("Chrome on Mac");
});

test("device actions run on the browser and offline sends are queued then delivered", async ({ browser }) => {
  const a = await onboard(browser, "Laptop");
  const target = `${new URL(a.url()).origin}/icon.svg`;
  const popup = a.context().waitForEvent("page");
  await a.getByTestId("composer").fill(`open ${target} for me`);
  await a.getByTestId("send").click();
  const opened = await popup;
  await opened.waitForLoadState();
  expect(opened.url()).toBe(target);
  await expect(a.getByTestId("tool-card").filter({ hasText: "open_url" })).toContainText("done on", { timeout: 20_000 });
  await expect(a.getByTestId("assistant-msg")).toHaveAttribute("data-status", "complete", { timeout: 20_000 });

  await a.context().setOffline(true);
  await expect(a.getByTestId("conn")).toHaveText(/offline|connecting/, { timeout: 15_000 });
  await a.getByTestId("composer").fill("what time is it?");
  await a.getByTestId("send").click();
  await expect(a.locator(".composer")).toContainText("1 queued");
  await a.context().setOffline(false);
  await expect(a.getByTestId("conn")).toHaveText(/live/, { timeout: 20_000 });
  await expect(a.locator(".composer")).not.toContainText("queued", { timeout: 20_000 });
  await expect(a.getByTestId("tool-card").filter({ hasText: "get_time" })).toBeVisible({ timeout: 20_000 });
  await expect(a.getByTestId("assistant-msg").nth(1)).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
});
