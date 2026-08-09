import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/types";
import { migrations } from "./migrations";

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

type RouteHandler = (
  url: URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function mockFetch(routes: Record<string, RouteHandler>) {
  const mock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      for (const [pattern, handler] of Object.entries(routes)) {
        if (url.href.includes(pattern)) {
          return await handler(url, init);
        }
      }
      throw new Error(`unexpected request: ${url.href}`);
    },
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const tokenResponse = {
  access_token: "user-access-token",
  refresh_token: "user-refresh-token",
  expires_in: 3600,
  scope: ["user:read:email"], // Twitch は配列で返す(実測)
  token_type: "bearer",
};

const usersResponse = {
  data: [
    {
      id: "130871908",
      login: "azumagbanjo",
      display_name: "あずまぐ",
      profile_image_url: "https://example.com/avatar.png",
    },
  ],
};

const twitchRoutes = {
  "id.twitch.tv/oauth2/token": async () => jsonResponse(tokenResponse),
  "api.twitch.tv/helix/users": async () => jsonResponse(usersResponse),
};

async function fetchAs(env: AppEnv, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function extractSessionToken(res: Response): string | null {
  const setCookie = res.headers.get("Set-Cookie");
  const match = setCookie?.match(/orbsky_session=([^;]+)/);
  return match?.[1] ?? null;
}

async function loginAndGetCookie(env: AppEnv): Promise<{ token: string; csrf: string }> {
  // ログイン開始 → state を KV から取得
  const loginRes = await fetchAs(env, new Request("https://example.com/auth/twitch/login"));
  expect(loginRes.status).toBe(302);
  const loginUrl = new URL(loginRes.headers.get("Location")!);
  const state = loginUrl.searchParams.get("state")!;

  // コールバック
  const cbRes = await fetchAs(
    env,
    new Request(
      `https://example.com/auth/twitch/callback?state=${state}&code=the-code`,
    ),
  );
  expect(cbRes.status).toBe(302);
  const token = extractSessionToken(cbRes)!;
  expect(token).toBeTruthy();

  // セッションから csrf を復元
  const session = await env.STATE.get("session:" + token, "json") as {
    csrf: string;
  };
  return { token, csrf: session.csrf };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Twitch OAuth ログイン", () => {
  it("GET /auth/twitch/login が認可URLへリダイレクトし state を保存する", async () => {
    const res = await fetchAs(
      makeEnv(),
      new Request("https://example.com/auth/twitch/login"),
    );
    expect(res.status).toBe(302);

    const url = new URL(res.headers.get("Location")!);
    expect(url.origin + url.pathname).toBe(
      "https://id.twitch.tv/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      env.TWITCH_OAUTH_REDIRECT_URL,
    );
    expect(url.searchParams.get("scope")).toBe(
      "user:read:email user:read:subscriptions",
    );
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    await expect(env.STATE.get("oauth_state:" + state)).resolves.toBe("1");
  });

  it("コールバックでトークン交換→ユーザー保存→セッション発行", async () => {
    mockFetch(twitchRoutes);
    const env0 = makeEnv();

    // ログイン開始
    const loginRes = await fetchAs(env0, new Request("https://example.com/auth/twitch/login"));
    const state = new URL(loginRes.headers.get("Location")!).searchParams.get("state")!;

    const cbRes = await fetchAs(
      env0,
      new Request(
        `https://example.com/auth/twitch/callback?state=${state}&code=the-code`,
      ),
    );
    expect(cbRes.status).toBe(302);
    // Bluesky未連携なので、投稿設定より先にBluesky連携へ誘導する
    expect(cbRes.headers.get("Location")).toBe("/settings");
    const setCookie = cbRes.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    // state は使い捨て
    await expect(env.STATE.get("oauth_state:" + state)).resolves.toBeNull();

    // DB に保存されている(暗号化)
    const row = await env0.DB.prepare(
      "SELECT * FROM users WHERE twitch_user_id = ?",
    )
      .bind("130871908")
      .first<{
        twitch_username: string;
        twitch_access_token_enc: string;
        twitch_refresh_token_enc: string;
      }>();
    expect(row?.twitch_username).toBe("azumagbanjo");
    expect(row?.twitch_access_token_enc).toContain("v1:");
    expect(row?.twitch_access_token_enc).not.toContain("user-access-token");
    expect(row?.twitch_refresh_token_enc).toContain("v1:");
  });

  it("再ログインで既存ユーザーが更新される(重複しない)", async () => {
    mockFetch(twitchRoutes);
    const env0 = makeEnv();

    await loginAndGetCookie(env0);
    await loginAndGetCookie(env0);

    const { results } = await env0.DB.prepare("SELECT COUNT(*) AS c FROM users").all<{
      c: number;
    }>();
    expect(results[0].c).toBe(1);
  });

  it("state が無効な場合はエラーページ", async () => {
    mockFetch(twitchRoutes);
    const res = await fetchAs(
      makeEnv(),
      new Request("https://example.com/auth/twitch/callback?state=bad&code=x"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("認可が無効");
  });

  it("トークン交換失敗時はエラーページ", async () => {
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({ error: "invalid_grant", message: "bad code" }, 400),
    });
    const env0 = makeEnv();

    const loginRes = await fetchAs(env0, new Request("https://example.com/auth/twitch/login"));
    const state = new URL(loginRes.headers.get("Location")!).searchParams.get("state")!;

    const res = await fetchAs(
      env0,
      new Request(`https://example.com/auth/twitch/callback?state=${state}&code=bad`),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ログインに失敗");
  });
});

describe("ページとログアウト", () => {
  it("未ログインの / はログインリンクを表示する", async () => {
    const res = await fetchAs(makeEnv(), new Request("https://example.com/"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Twitchでログイン");
    expect(body).toContain("/auth/twitch/login");
  });

  it("ログイン済みの / はログイン状態とログアウトフォームを表示する", async () => {
    mockFetch(twitchRoutes);
    const env0 = makeEnv();
    const { token, csrf } = await loginAndGetCookie(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/", {
        headers: { Cookie: `orbsky_session=${token}` },
      }),
    );
    const body = await res.text();
    expect(body).toContain("Twitchログイン済み");
    expect(body).toContain(csrf);
    expect(body).toContain("/auth/logout");
  });

  it("正しい CSRF でログアウトできる", async () => {
    mockFetch(twitchRoutes);
    const env0 = makeEnv();
    const { token, csrf } = await loginAndGetCookie(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/auth/logout", {
        method: "POST",
        headers: { Cookie: `orbsky_session=${token}` },
        body: new URLSearchParams({ csrf }),
      }),
    );
    expect(res.status).toBe(302);
    await expect(env.STATE.get("session:" + token)).resolves.toBeNull();
  });

  it("誤った CSRF ではログアウトできない", async () => {
    mockFetch(twitchRoutes);
    const env0 = makeEnv();
    const { token } = await loginAndGetCookie(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/auth/logout", {
        method: "POST",
        headers: { Cookie: `orbsky_session=${token}` },
        body: new URLSearchParams({ csrf: "wrong" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("無効なリクエスト");
    await expect(env.STATE.get("session:" + token)).resolves.toBeTruthy();
  });
});
