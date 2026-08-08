import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/types";
import {
  clearSessionCookieHeader,
  createSession,
  deleteSession,
  getSession,
  sessionCookieHeader,
} from "../src/lib/session";

function makeEnv(): AppEnv {
  return {
    ...env,
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    TWITCH_BROADCASTER_ID: "12345",
    BSKY_HANDLE: "test.bsky.social",
    BSKY_APP_PASSWORD: "test-app-password",
    ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    TWITCH_OAUTH_REDIRECT_URL: env.TWITCH_OAUTH_REDIRECT_URL,
  } as AppEnv;
}

function requestWithCookie(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers["Cookie"] = `tw2bs_session=${token}`;
  return new Request("https://example.com/", { headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session", () => {
  it("creates and validates a session", async () => {
    const e = makeEnv();
    const { token, csrf } = await createSession(e, "user-1");

    expect(csrf).toBeTruthy();
    const session = await getSession(e, requestWithCookie(token));
    expect(session?.twitchUserId).toBe("user-1");
    expect(session?.csrf).toBe(csrf);
    expect(session!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns null without a cookie", async () => {
    await expect(getSession(makeEnv(), requestWithCookie())).resolves.toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const e = makeEnv();
    await expect(getSession(e, requestWithCookie("unknown"))).resolves.toBeNull();
  });

  it("returns null for an expired session and removes it", async () => {
    const e = makeEnv();
    const { token } = await createSession(e, "user-1");
    // 期限切れに書き換え
    await env.STATE.put(
      "session:" + token,
      JSON.stringify({
        twitchUserId: "user-1",
        csrf: "x",
        expiresAt: Date.now() - 1000,
      }),
    );

    await expect(getSession(e, requestWithCookie(token))).resolves.toBeNull();
    await expect(env.STATE.get("session:" + token)).resolves.toBeNull();
  });

  it("deletes the session", async () => {
    const e = makeEnv();
    const { token } = await createSession(e, "user-1");

    await deleteSession(e, requestWithCookie(token));
    await expect(getSession(e, requestWithCookie(token))).resolves.toBeNull();
  });

  it("builds the session cookie header with security flags", () => {
    const header = sessionCookieHeader("tok", true);
    expect(header).toContain("tw2bs_session=tok");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
    expect(clearSessionCookieHeader()).toContain("Max-Age=0");
  });
});
