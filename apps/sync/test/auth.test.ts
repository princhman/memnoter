import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { BASE, signIn } from "./helpers";
import contract from "./fixtures/protocol.json";

function post(path: string, body: unknown, token?: string) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

describe("sign-in", () => {
  it("issues a token for the right code and keeps the user id", async () => {
    const first = await signIn("Ada@Example.com");
    expect(first.token).toMatch(/\./);
    expect(Object.keys(first).sort()).toEqual(Object.keys(contract.httpFixtures.verify).sort());
    // Codes cannot be requested again for 30 seconds; a second account works.
    const other = await signIn("grace@example.com");
    expect(other.userId).not.toBe(first.userId);
  });

  it("rejects a wrong code and limits attempts", async () => {
    const start = await post("/v1/auth/start", { email: "eve@example.com" });
    const { devCode } = await start.json<{ devCode: string }>();
    const wrong = devCode === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await post("/v1/auth/verify", { email: "eve@example.com", code: wrong })).status).toBe(401);
    }
    // Locked even with the right code now.
    expect((await post("/v1/auth/verify", { email: "eve@example.com", code: devCode })).status).toBe(401);
  });

  it("rate-limits sending codes", async () => {
    expect((await post("/v1/auth/start", { email: "rate@example.com" })).status).toBe(200);
    expect((await post("/v1/auth/start", { email: "rate@example.com" })).status).toBe(429);
  });

  it("limits sign-in requests per IP address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const response = await SELF.fetch(`${BASE}/v1/auth/start`, {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({ email: `limit-${i}@example.com` }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("rejects invalid emails", async () => {
    expect((await post("/v1/auth/start", { email: "not-an-email" })).status).toBe(400);
  });
});

describe("App Review sign-in", () => {
  const email = "review@example.com";
  const code = "172635481902";
  const enabled = { REVIEW_EMAIL: email, REVIEW_CODE: code };

  function client(bindings: Pick<Env, "REVIEW_EMAIL" | "REVIEW_CODE">) {
    const address = bindings.REVIEW_EMAIL ?? email;
    const send = vi.fn<NonNullable<Env["EMAIL"]>["send"]>(async () => {});
    const workerEnv = { ...env, ...bindings, DEV_RETURN_CODE: undefined, EMAIL: { send } };
    const request = (path: string, init: RequestInit<IncomingRequestCfProperties>) =>
      worker.fetch(new Request(BASE + path, init), workerEnv);
    const auth = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) });
    return {
      send,
      start: (email = address) => auth(contract.paths.authStart, { email }),
      verify: (guess: string, email = address) => auth(contract.paths.authVerify, { email, code: guess }),
      authenticated: (path: string, token: string, method = "GET") =>
        request(path, { method, headers: { Authorization: `Bearer ${token}` } }),
    };
  }

  it.each([
    { name: "both secrets are unset", bindings: {} },
    { name: "only the email is set", bindings: { REVIEW_EMAIL: email } },
    { name: "only the code is set", bindings: { REVIEW_CODE: code } },
    { name: "the configured code is shorter than 12 characters", bindings: { ...enabled, REVIEW_CODE: "12345678901" } },
  ])("uses the emailed code when $name", async ({ bindings }) => {
    const { start, verify, send } = client(bindings);
    const response = await start();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: email }));
    const emailedCode = send.mock.calls[0][0].subject.match(/\d{6}$/)?.[0];
    expect(emailedCode).toBeDefined();
    expect((await verify(bindings.REVIEW_CODE ?? code)).status).toBe(400);
    expect((await verify(emailedCode!)).status).toBe(200);
  });

  it("signs in the designated email without sending a code and supports account deletion", async () => {
    const { start, verify, send, authenticated } = client(enabled);
    const signInReview = async () => {
      const started = await start("  Review@Example.COM  ");
      expect(started.status).toBe(200);
      expect(await started.json()).toEqual({ ok: true });
      const verified = await verify(code, "  Review@Example.COM  ");
      expect(verified.status).toBe(200);
      return verified.json<{ token: string; userId: string; email: string }>();
    };

    const first = await signInReview();
    expect(first.email).toBe(email);
    expect(send).not.toHaveBeenCalled();
    expect(await (await authenticated(contract.paths.key, first.token)).json()).toEqual(contract.httpFixtures.newKey);
    expect((await signInReview()).userId).toBe(first.userId);

    expect((await authenticated(contract.paths.account, first.token, "DELETE")).status).toBe(200);
    expect((await authenticated(contract.paths.key, first.token)).status).toBe(401);
    expect((await signInReview()).userId).not.toBe(first.userId);

    const other = "another@example.com";
    expect((await start(other)).status).toBe(200);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: other }));
    expect((await verify(code, other)).status).toBe(400);
  });

  it("rejects a wrong review code and enforces the normal attempt and resend limits", async () => {
    const { start, verify } = client({ ...enabled, REVIEW_EMAIL: "review-attempts@example.com" });
    expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(429);
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await verify("172635481903");
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "That code is wrong or has expired" });
    }
    expect((await verify(code)).status).toBe(401);
  });
});

describe("key info", () => {
  it("requires a token", async () => {
    expect((await SELF.fetch(`${BASE}/v1/key`)).status).toBe(401);
    const invalid = await SELF.fetch(`${BASE}${contract.paths.key}`, { headers: { Authorization: "Bearer a.b" } });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual(contract.httpFixtures.expired);
  });

  it("keeps the first device's salt", async () => {
    const { token } = await signIn("keys@example.com");
    const get = await SELF.fetch(`${BASE}/v1/key`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await get.json()).toEqual(contract.httpFixtures.newKey);

    const put = (salt: string) =>
      SELF.fetch(`${BASE}/v1/key`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ salt, check: "check" }),
      }).then((response) => response.json<{ key: { salt: string } }>());
    expect((await put("first")).key.salt).toBe("first");
    expect((await put("second")).key.salt).toBe("first");
  });
});

describe("sync socket", () => {
  it("refuses connections without a valid token", async () => {
    const response = await SELF.fetch(`${BASE}/v1/sync`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "memnoter.v1, auth.bad.token" },
    });
    expect(response.status).toBe(401);
  });
});

it("gates file deletion by protocol without breaking headerless v0.1.5", async () => {
  const { token } = await signIn("file-version@example.com");
  const id = "00000000-0000-4000-8000-000000000382";
  const url = `${BASE}/v1/files/${id}`;
  const auth = { Authorization: `Bearer ${token}` };
  await SELF.fetch(url, { method: "PUT", headers: { ...auth, "Content-Length": "3" }, body: "abc" });
  for (const version of ["0", "1", String(contract.version + 1), "", "garbage"]) {
    const response = await SELF.fetch(url, { method: "DELETE", headers: { ...auth, "X-Memnoter-Protocol-Version": version } });
    expect(response.status).toBe(426);
    expect(await response.json()).toEqual({ error: "Please update Memnoter to keep syncing" });
    expect((await SELF.fetch(url, { headers: auth })).status).toBe(200);
  }
  // Tagged v0.1.5 sends no version header. It cannot erase worksheet assets.
  expect((await SELF.fetch(url, { method: "DELETE", headers: auth })).status).toBe(426);
  expect((await SELF.fetch(url, { headers: auth })).status).toBe(200);
  expect((await SELF.fetch(url, { method: "DELETE", headers: { ...auth, "X-Memnoter-Protocol-Version": String(contract.version) } })).status).toBe(200);
  expect((await SELF.fetch(url, { headers: auth })).status).toBe(410);
});
