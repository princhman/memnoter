import type { Account } from "./account";
import type { Vault } from "./vault";

export interface Env {
  VAULT: DurableObjectNamespace<Vault>;
  ACCOUNT: DurableObjectNamespace<Account>;
  // Encrypted images and log blobs too large for a Durable Object row.
  FILES: R2Bucket;
  // Limits sign-in requests per IP address.
  AUTH_LIMITER?: RateLimit;
  EMAIL?: SendEmail;
  // HMAC key for session tokens. Set with `wrangler secret put AUTH_SECRET`.
  AUTH_SECRET: string;
  EMAIL_FROM: string;
  // Local development only: return sign-in codes in the response instead of
  // emailing them. Never set this in production.
  DEV_RETURN_CODE?: string;
}

type SendEmail = {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
};
