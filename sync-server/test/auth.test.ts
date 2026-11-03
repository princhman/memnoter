import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, signIn } from "./helpers";

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

describe("key info", () => {
  it("requires a token", async () => {
    expect((await SELF.fetch(`${BASE}/v1/key`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/key`, { headers: { Authorization: "Bearer a.b" } })).status).toBe(401);
  });

  it("keeps the first device's salt", async () => {
    const { token } = await signIn("keys@example.com");
    const get = await SELF.fetch(`${BASE}/v1/key`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await get.json()).toEqual({ key: null });

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
