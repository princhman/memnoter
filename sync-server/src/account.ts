import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;

type Pending = { codeHash: string; expiresAt: number; sentAt: number; attempts: number };

export type StartResult = { code: string } | { retryAfterMs: number };

// One per email address: maps it to a stable user id and holds the pending
// sign-in code. Only a hash of the code is stored.
export class Account extends DurableObject<Env> {
  async startSignIn(): Promise<StartResult> {
    const now = Date.now();
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (pending && now - pending.sentAt < RESEND_AFTER_MS) {
      return { retryAfterMs: RESEND_AFTER_MS - (now - pending.sentAt) };
    }
    const code = randomCode();
    await this.ctx.storage.put("pending", {
      codeHash: await sha256(code),
      expiresAt: now + CODE_TTL_MS,
      sentAt: now,
      attempts: 0,
    } satisfies Pending);
    return { code };
  }

  // The user id when the code is right; null otherwise. A code works once.
  async verify(code: string): Promise<string | null> {
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (!pending || Date.now() > pending.expiresAt || pending.attempts >= MAX_ATTEMPTS) return null;
    if ((await sha256(code)) !== pending.codeHash) {
      await this.ctx.storage.put("pending", { ...pending, attempts: pending.attempts + 1 });
      return null;
    }
    await this.ctx.storage.delete("pending");
    let userId = await this.ctx.storage.get<string>("userId");
    if (!userId) {
      userId = crypto.randomUUID();
      await this.ctx.storage.put("userId", userId);
    }
    return userId;
  }
}

function randomCode() {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return String(value % 1_000_000).padStart(6, "0");
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
