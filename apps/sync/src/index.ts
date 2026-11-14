// Sync service entry point for sync.memnoter.com.
import { TOKEN_TTL_MS, signToken, verifyToken, type Claims } from "./token";
import type { Env } from "./env";
import type { KeyInfo } from "./vault";
import { blobKey, fileKey, goneKey } from "./storage";
import {
  PROTOCOL_VERSION, PROTOCOL_HEADER, UPDATE_REQUIRED_MESSAGE,
  AUTH_PROTOCOL_PREFIX,
  MAX_FILE_BYTES,
  MAX_LARGE_BLOB_BYTES,
  SYNC_PROTOCOL,
  isValidBlobId,
  isValidFileId,
} from "../../shared-ui/src/lib/sync/protocol";

// Only Durable Object classes and the default handler may be exported here.
export { Vault } from "./vault";
export { Account } from "./account";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Memnoter-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    try {
      const response = await route(request, env);
      if (response.status === 101) return response;
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      console.error("Request failed", error);
      return json({ error: "Server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname.startsWith("/v1/auth/")) {
    if (!(await withinAuthLimit(request, env))) return json({ error: "Too many attempts. Try again in a minute." }, 429);
    if (pathname === "/v1/auth/start" && method === "POST") return startSignIn(request, env);
    if (pathname === "/v1/auth/verify" && method === "POST") return verifySignIn(request, env);
    return json({ error: "Not found" }, 404);
  }

  if (pathname === "/v1/sync") return connect(request, env);

  const claims = await authenticate(request, env);
  if (!claims) return json({ error: "Sign in again" }, 401);
  const vault = env.VAULT.getByName(claims.sub);
  if (!(await vault.authorize(claims.sub, claims.iat))) return json({ error: "Sign in again" }, 401);

  if (pathname === "/v1/key" && method === "GET") {
    return json({ key: await vault.getKeyInfo() });
  }
  if (pathname === "/v1/key" && method === "PUT") {
    const body = await readJson<Partial<KeyInfo>>(request);
    if (!isKeyInfo(body)) return json({ error: "Invalid key info" }, 400);
    return json({ key: await vault.setKeyInfo(body) });
  }
  if (pathname === "/v1/vault" && method === "DELETE") {
    await vault.wipe();
    return json({ ok: true });
  }

  // Encrypted images and large log blobs. Both are immutable once written.
  const object = pathname.match(/^\/v1\/(files|blobs)\/([^/]+)$/);
  if (object) {
    const [, kind, id] = object;
    const valid = kind === "files" ? isValidFileId(id) : isValidBlobId(id);
    if (!valid) return json({ error: "Invalid id" }, 400);
    const key = kind === "files" ? fileKey(claims.sub, id) : blobKey(claims.sub, id);
    if (kind === "files" && method === "DELETE") {
      // Headerless v0.1.5 uses protocol 1. Keep this fixed when the server
      // protocol advances: legacy clients must then lose deletion access too.
      const version = request.headers.get(PROTOCOL_HEADER) ?? "1";
      if (version !== String(PROTOCOL_VERSION)) return json({ error: UPDATE_REQUIRED_MESSAGE }, 426);
      // Publish permanence before removing bytes, including when deletion is retried.
      await env.FILES.put(goneKey(claims.sub, id), new Uint8Array());
      await env.FILES.delete(key);
      return json({ ok: true });
    }
    if (kind === "files" && (method === "GET" || method === "PUT") && await env.FILES.head(goneKey(claims.sub, id))) {
      return json({ error: "File permanently deleted" }, 410);
    }
    if (method === "PUT") return putObject(request, env, key, kind === "files" ? MAX_FILE_BYTES : MAX_LARGE_BLOB_BYTES);
    if (method === "GET") {
      const stored = await env.FILES.get(key);
      if (!stored) return json({ error: "Not found" }, 404);
      return new Response(stored.body, {
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(stored.size) },
      });
    }
  }
  return json({ error: "Not found" }, 404);
}

async function putObject(request: Request, env: Env, key: string, maxBytes: number) {
  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isFinite(length) || length <= 0) return json({ error: "Content-Length is required" }, 411);
  if (length > maxBytes) return json({ error: "Too large" }, 413);
  if (!request.body) return json({ error: "Empty body" }, 400);
  await env.FILES.put(key, request.body);
  return json({ ok: true });
}

async function withinAuthLimit(request: Request, env: Env) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !env.AUTH_LIMITER) return true;
  return (await env.AUTH_LIMITER.limit({ key: ip })).success;
}

async function startSignIn(request: Request, env: Env) {
  const body = await readJson<{ email?: unknown }>(request);
  const email = normalizeEmail(body?.email);
  if (!email) return json({ error: "Enter a valid email address" }, 400);

  const result = await env.ACCOUNT.getByName(email).startSignIn();
  if ("retryAfterMs" in result) {
    return json({ error: "A code was just sent. Wait a moment and try again.", retryAfterMs: result.retryAfterMs }, 429);
  }
  if (env.DEV_RETURN_CODE === "1") return json({ ok: true, devCode: result.code });
  if (!env.EMAIL) return json({ error: "Email sending is not configured" }, 503);

  await env.EMAIL.send({
    to: email,
    from: { email: env.EMAIL_FROM, name: "Memnoter" },
    subject: `Your Memnoter code: ${result.code}`,
    text: `Your Memnoter sign-in code is ${result.code}. It expires in 10 minutes.\n\nIf you did not ask for it, you can ignore this email.`,
  });
  return json({ ok: true });
}

async function verifySignIn(request: Request, env: Env) {
  const body = await readJson<{ email?: unknown; code?: unknown }>(request);
  const email = normalizeEmail(body?.email);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!email || !/^\d{6}$/.test(code)) return json({ error: "Enter the 6-digit code" }, 400);

  const userId = await env.ACCOUNT.getByName(email).verify(code);
  if (!userId) return json({ error: "That code is wrong or has expired" }, 401);

  const now = Date.now();
  const claims: Claims = { sub: userId, email, iat: now, exp: now + TOKEN_TTL_MS };
  return json({ token: await signToken(claims, env.AUTH_SECRET), userId, email });
}

async function connect(request: Request, env: Env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket", { status: 426 });
  }
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((part) => part.trim());
  const token = protocols.find((part) => part.startsWith(AUTH_PROTOCOL_PREFIX))?.slice(AUTH_PROTOCOL_PREFIX.length);
  const claims = token ? await verifyToken(token, env.AUTH_SECRET) : null;
  if (!claims) return new Response("Sign in again", { status: 401 });
  if (!(await hasSyncAccess(env, claims.sub))) return new Response("Sync needs a subscription", { status: 402 });

  const headers = new Headers(request.headers);
  if (protocols.includes(SYNC_PROTOCOL)) headers.set("X-Selected-Protocol", SYNC_PROTOCOL);
  headers.set("X-User-Id", claims.sub);
  headers.set("X-Token-Iat", String(claims.iat));
  return env.VAULT.getByName(claims.sub).fetch(new Request(request, { headers }));
}

// Phase 4 (billing) decides this from the user's entitlement.
async function hasSyncAccess(_env: Env, _userId: string) {
  return true;
}

async function authenticate(request: Request, env: Env) {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token ? verifyToken(token, env.AUTH_SECRET) : null;
}

function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function isKeyInfo(value: Partial<KeyInfo> | null): value is KeyInfo {
  return (
    typeof value?.salt === "string" &&
    typeof value.check === "string" &&
    value.salt.length <= 128 &&
    value.check.length <= 512
  );
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}
