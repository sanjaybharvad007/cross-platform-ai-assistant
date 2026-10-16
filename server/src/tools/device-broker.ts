/**
 * Routes tool calls that must run on a device (open a URL, set an alarm, read
 * location) to a connected client and awaits the result.  The request is also
 * persisted as a `device.action` event, so a device that connects later - or
 * a different device of the same user - can still fulfil it before it expires.
 */
import type { DeviceAction } from "@assistant/protocol";

interface Pending {
  action: DeviceAction;
  resolve: (r: { ok: boolean; result: unknown; deviceId: string }) => void;
  timer: NodeJS.Timeout;
}

export class DeviceBroker {
  private pending = new Map<string, Pending>();

  wait(action: DeviceAction, timeoutMs: number): Promise<{ ok: boolean; result: unknown; deviceId: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(action.id);
        resolve({ ok: false, result: { error: "no device completed the action in time" }, deviceId: "" });
      }, timeoutMs);
      this.pending.set(action.id, { action, resolve, timer });
    });
  }

  /** Called when a client reports a result. Returns false for unknown / already-settled actions. */
  complete(actionId: string, deviceId: string, ok: boolean, result: unknown): boolean {
    const p = this.pending.get(actionId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(actionId);
    p.resolve({ ok, result, deviceId });
    return true;
  }

  cancelAll(conversationId: string) {
    for (const [id, p] of this.pending) if (p.action.conversationId === conversationId) { clearTimeout(p.timer); this.pending.delete(id); p.resolve({ ok: false, result: { error: "cancelled" }, deviceId: "" }); }
  }

  get size() { return this.pending.size; }
}
