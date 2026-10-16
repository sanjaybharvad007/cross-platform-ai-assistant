/**
 * Device-based identity.  A device registers once and receives a long-lived
 * JWT bound to (userId, deviceId).  Additional devices join the same user with
 * a short-lived six-digit pairing code generated on an already signed-in
 * device - no passwords, no accounts to create on a phone keyboard.
 */
import { SignJWT, jwtVerify } from "jose";
import { Device, parse } from "@assistant/protocol";
import { newId, type Db } from "./db.js";

export interface Identity {
  userId: string;
  deviceId: string;
}

export class Auth {
  private readonly key: Uint8Array;
  constructor(
    private readonly db: Db,
    secret: string,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async registerDevice(name: string, platform: Device["platform"], pairCode?: string): Promise<{ token: string } & Identity> {
    const now = Date.now();
    let userId: string;
    if (pairCode) {
      const row = this.db.prepare("SELECT user_id, expires_at FROM pair_codes WHERE code = ?").get(pairCode) as { user_id: string; expires_at: number } | undefined;
      if (!row || row.expires_at < now) throw new AuthError("invalid or expired pairing code");
      this.db.prepare("DELETE FROM pair_codes WHERE code = ?").run(pairCode);
      userId = row.user_id;
    } else {
      userId = newId("usr");
      this.db.prepare("INSERT INTO users(id, created_at) VALUES (?, ?)").run(userId, now);
    }
    const deviceId = newId("dev");
    this.db.prepare("INSERT INTO devices(id, user_id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run(deviceId, userId, name, platform, now, now);
    return { token: await this.sign({ userId, deviceId }), userId, deviceId };
  }

  async sign(id: Identity): Promise<string> {
    return new SignJWT({ did: id.deviceId }).setProtectedHeader({ alg: "HS256" }).setSubject(id.userId).setIssuedAt().setExpirationTime("365d").sign(this.key);
  }

  async verify(token: string): Promise<Identity> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
      const deviceId = payload.did;
      if (typeof deviceId !== "string" || !payload.sub) throw new Error("bad claims");
      const dev = this.db.prepare("SELECT user_id FROM devices WHERE id = ?").get(deviceId) as { user_id: string } | undefined;
      if (!dev || dev.user_id !== payload.sub) throw new Error("device revoked");
      return { userId: payload.sub, deviceId };
    } catch (e) {
      throw new AuthError(`invalid token: ${(e as Error).message}`);
    }
  }

  createPairCode(userId: string, ttlMs = 5 * 60_000): { code: string; expiresAt: number } {
    this.db.prepare("DELETE FROM pair_codes WHERE expires_at < ?").run(Date.now());
    for (let i = 0; i < 10; i++) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
      const expiresAt = Date.now() + ttlMs;
      try {
        this.db.prepare("INSERT INTO pair_codes(code, user_id, expires_at) VALUES (?, ?, ?)").run(code, userId, expiresAt);
        return { code, expiresAt };
      } catch {
        /* collision, retry */
      }
    }
    throw new Error("could not allocate pairing code");
  }

  devices(userId: string, online: Set<string>): Device[] {
    return (this.db.prepare("SELECT id, name, platform, last_seen_at FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC").all(userId) as Array<Record<string, unknown>>).map((r) =>
      parse(Device, { id: r.id, name: r.name, platform: r.platform, lastSeenAt: r.last_seen_at, online: online.has(r.id as string) }));
  }

  touchDevice(deviceId: string) {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), deviceId);
  }
}

export class AuthError extends Error {
  override name = "AuthError";
}
