import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const encoder = new TextEncoder();

// A null hash marks a review challenge. Its code comes from the active Worker secret.
type Pending = { codeHash: string | null; expiresAt: number; sentAt: number; attempts: number };

export type StartResult = { code: string | null } | { retryAfterMs: number };

// One per email address: maps it to a stable user id and holds the pending
// sign-in code. Only a hash of the code is stored.
export class Account extends DurableObject<Env> {
  async startSignIn(review: boolean): Promise<StartResult> {
    const code = review ? null : randomCode();
    const codeHash = code === null ? null : await sha256(code);
    const now = Date.now();
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (pending && now - pending.sentAt < RESEND_AFTER_MS) {
      return { retryAfterMs: RESEND_AFTER_MS - (now - pending.sentAt) };
    }
    await this.ctx.storage.put("pending", {
      codeHash,
      expiresAt: now + CODE_TTL_MS,
      sentAt: now,
      attempts: 0,
    } satisfies Pending);
    return { code };
  }

  // The user id when the code is right. A pending challenge works once.
  async verify(code: string, reviewCode?: string): Promise<string | null> {
    const codeHash = await sha256(code);
    const reviewHash = reviewCode === undefined ? null : await sha256(reviewCode);
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (!pending || Date.now() > pending.expiresAt || pending.attempts >= MAX_ATTEMPTS) return null;
    const expectedHash = pending.codeHash ?? reviewHash;
    if (expectedHash === null || (pending.codeHash !== null && reviewHash !== null)) return null;
    if (!crypto.subtle.timingSafeEqual(encoder.encode(codeHash), encoder.encode(expectedHash))) {
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

  async deleteIfMatches(userId: string): Promise<void> {
    // A retry for the old vault must leave any replacement account alone.
    if (await this.ctx.storage.get<string>("userId") === userId) await this.ctx.storage.deleteAll();
  }
}

function randomCode() {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return String(value % 1_000_000).padStart(6, "0");
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
