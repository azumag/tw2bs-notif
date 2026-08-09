import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/types";
import { migrations } from "./migrations";
import { createSession } from "../src/lib/session";
import {
  checkTwitchSubViaApi,
  hasTwitchSub,
  refreshTwitchSubCheck,
  setTwitchSubCheckDisabled,
} from "../src/lib/sub-check";
import { hasActiveEntitlement } from "../src/lib/support";

function makeEnv(): AppEnv {
  return {
    ...env,
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    TWITCH_BROADCASTER_ID: "130871908",
    BSKY_HANDLE: "test.bsky.social",
    BSKY_APP_PASSWORD: "test-app-password",
    ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    TWITCH_OAUTH_REDIRECT_URL: env.TWITCH_OAUTH_REDIRECT_URL,
    EVENTSUB_CALLBACK_URL: env.EVENTSUB_CALLBACK_URL,
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

async function createUser(env0: AppEnv, userId: string) {
  const enc = await import("../src/lib/crypto");
  const token = await enc.encryptSecret(env0, "user-access-token");
  const refresh = await enc.encryptSecret(env0, "user-refresh-token");
  await env0.DB.prepare(
    `INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name,
       twitch_access_token_enc, twitch_refresh_token_enc, twitch_token_expires_at, twitch_scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      "azumagbanjo",
      "あずまぐ",
      token,
      refresh,
      Date.now() + 3600 * 1000,
      JSON.stringify(["user:read:subscriptions"]),
    )
    .run();
}

async function fetchAs(env0: AppEnv, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env0, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const subUrl = "api.twitch.tv/helix/subscriptions/user";

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasTwitchSub", () => {
  it("サブスク中なら true を返しキャッシュする", async () => {
    mockFetch({
      [subUrl]: async () =>
        jsonResponse({ data: [{ user_id: "user-1", tier: "1000" }] }),
    });
    const env0 = makeEnv();
    await createUser(env0, "user-1");

    await expect(hasTwitchSub(env0, "user-1")).resolves.toBe(true);

    // キャッシュが保存される
    const row = await env0.DB.prepare(
      "SELECT twitch_has_sub AS h FROM users WHERE twitch_user_id = ?",
    )
      .bind("user-1")
      .first<{ h: number }>();
    expect(row?.h).toBe(1);

    // 2回目は API を呼ばない(キャッシュ)
    const fetchMock = mockFetch({
      [subUrl]: async () => {
        throw new Error("should not be called");
      },
    });
    await expect(hasTwitchSub(env0, "user-1")).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("サブスクしていない(404)なら false", async () => {
    mockFetch({
      [subUrl]: async () =>
        jsonResponse({ error: "Not Found", message: "not found" }, 404),
    });
    const env0 = makeEnv();
    await createUser(env0, "user-1");

    await expect(hasTwitchSub(env0, "user-1")).resolves.toBe(false);
  });

  it("401(スコープ欠落)は前回値を維持し authError を返す", async () => {
    mockFetch({
      [subUrl]: async () =>
        jsonResponse({ error: "Unauthorized", message: "missing scope" }, 401),
    });
    const env0 = makeEnv();
    await createUser(env0, "user-1");

    const result = await checkTwitchSubViaApi(env0, "user-1");
    expect(result.authError).toBe(true);
    expect(result.hasSub).toBeNull();

    // キャッシュなしのため false に落ちるが、短縮TTLで再試行される
    await expect(hasTwitchSub(env0, "user-1")).resolves.toBe(false);
  });

  it("手動解除スイッチが ON なら false", async () => {
    const env0 = makeEnv();
    await createUser(env0, "user-1");
    await setTwitchSubCheckDisabled(env0, "user-1", true);

    const fetchMock = mockFetch({
      [subUrl]: async () => {
        throw new Error("should not be called");
      },
    });
    await expect(hasTwitchSub(env0, "user-1")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshTwitchSubCheck はキャッシュを無視して最新を確認する", async () => {
    mockFetch({
      [subUrl]: async () =>
        jsonResponse({ data: [{ user_id: "user-1", tier: "1000" }] }),
    });
    const env0 = makeEnv();
    await createUser(env0, "user-1");

    await expect(refreshTwitchSubCheck(env0, "user-1")).resolves.toBe(true);
  });
});

describe("特典判定の統合", () => {
  it("サブスク中なら hasActiveEntitlement が true", async () => {
    mockFetch({
      [subUrl]: async () =>
        jsonResponse({ data: [{ user_id: "user-1", tier: "1000" }] }),
    });
    const env0 = makeEnv();
    await createUser(env0, "user-1");

    await expect(hasActiveEntitlement(env0, "user-1")).resolves.toBe(true);
  });

  it("ライセンスが無くサブスクも無ければ false", async () => {
    mockFetch({
      [subUrl]: async () =>
        jsonResponse({ error: "Not Found", message: "not found" }, 404),
    });
    const env0 = makeEnv();
    await createUser(env0, "user-1");

    await expect(hasActiveEntitlement(env0, "user-1")).resolves.toBe(false);
  });
});

describe("サブスクページ(HTTP)", () => {
  it("再確認ボタンでサブスク状態が更新される", async () => {
    mockFetch({
      [subUrl]: async () =>
        jsonResponse({ data: [{ user_id: "user-1", tier: "1000" }] }),
    });
    const env0 = makeEnv();
    await createUser(env0, "user-1");
    const { token: sessionToken, csrf } = await createSession(env0, "user-1");

    const res = await fetchAs(
      env0,
      new Request("https://example.com/support/check-subscription", {
        method: "POST",
        headers: { Cookie: `orbsky_session=${sessionToken}` },
        body: new URLSearchParams({ csrf }),
      }),
    );
    expect(await res.text()).toContain("サブスク中です");
  });

  it("判定を無効化できる", async () => {
    const env0 = makeEnv();
    await createUser(env0, "user-1");
    const { token: sessionToken, csrf } = await createSession(env0, "user-1");

    const res = await fetchAs(
      env0,
      new Request("https://example.com/support/disable-subscription", {
        method: "POST",
        headers: { Cookie: `orbsky_session=${sessionToken}` },
        body: new URLSearchParams({ csrf }),
      }),
    );
    expect(res.status).toBe(302);

    const row = await env0.DB.prepare(
      "SELECT twitch_sub_check_disabled AS d FROM users WHERE twitch_user_id = ?",
    )
      .bind("user-1")
      .first<{ d: number }>();
    expect(row?.d).toBe(1);
  });

  it("無効中は再有効化できる", async () => {
    const env0 = makeEnv();
    await createUser(env0, "user-1");
    await setTwitchSubCheckDisabled(env0, "user-1", true);
    const { token: sessionToken, csrf } = await createSession(env0, "user-1");

    const res = await fetchAs(
      env0,
      new Request("https://example.com/support/enable-subscription", {
        method: "POST",
        headers: { Cookie: `orbsky_session=${sessionToken}` },
        body: new URLSearchParams({ csrf }),
      }),
    );
    expect(res.status).toBe(302);

    const row = await env0.DB.prepare(
      "SELECT twitch_sub_check_disabled AS d FROM users WHERE twitch_user_id = ?",
    )
      .bind("user-1")
      .first<{ d: number }>();
    expect(row?.d).toBe(0);
  });

  it("無効中はページに再有効化ボタンが表示される", async () => {
    const env0 = makeEnv();
    await createUser(env0, "user-1");
    await setTwitchSubCheckDisabled(env0, "user-1", true);
    const { token: sessionToken } = await createSession(env0, "user-1");

    const res = await fetchAs(
      env0,
      new Request("https://example.com/support", {
        headers: { Cookie: `orbsky_session=${sessionToken}` },
      }),
    );
    const body = await res.text();
    expect(body).toContain("判定を無効にしています");
    expect(body).toContain("/support/enable-subscription");
    expect(body).not.toContain("/support/check-subscription");
  });

  it("未ログインは拒否される", async () => {
    const res = await fetchAs(
      makeEnv(),
      new Request("https://example.com/support/check-subscription", {
        method: "POST",
        body: new URLSearchParams({ csrf: "x" }),
      }),
    );
    expect(await res.text()).toContain("無効なリクエスト");
  });
});
