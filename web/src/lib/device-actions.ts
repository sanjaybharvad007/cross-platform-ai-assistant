/** Device tools a browser can fulfil. Anything else is declined so a phone can pick it up. */
import type { DeviceAction } from "@assistant/protocol";

export async function runBrowserAction(a: DeviceAction): Promise<{ ok: boolean; result: unknown }> {
  const args = a.arguments as Record<string, string>;
  switch (a.name) {
    case "open_url": {
      // "noopener" in the feature string makes window.open return null even on success, so detach manually
      const w = window.open(args.url, "_blank");
      if (w) w.opener = null;
      return { ok: !!w, result: w ? { opened: args.url } : { error: "popup blocked" } };
    }
    case "copy_to_clipboard":
      await navigator.clipboard.writeText(args.text ?? "");
      return { ok: true, result: { copied: true } };
    case "share_text":
      if (!navigator.share) return { ok: false, result: { error: "Web Share API not available" } };
      await navigator.share({ text: args.text });
      return { ok: true, result: { shared: true } };
    case "notify": {
      if (!("Notification" in window)) return { ok: false, result: { error: "notifications unsupported" } };
      const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (perm !== "granted") return { ok: false, result: { error: "notifications denied" } };
      new Notification(args.title ?? "Assistant", { body: args.body });
      return { ok: true, result: { shown: true } };
    }
    case "get_location":
      return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
        (p) => resolve({ ok: true, result: { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy } }),
        (e) => resolve({ ok: false, result: { error: e.message } }), { timeout: 10_000 }));
    case "set_alarm":
      return { ok: false, result: { error: "alarms need the phone" } };
  }
}
