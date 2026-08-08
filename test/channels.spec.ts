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

const usersResponse = {
  data: [
    {
      id: "12345",
      login: "azumagbanjo",
      display_name: "あずまぐ",
      profile_image_url: "https://example.com/avatar.png",
    },
  ],
};

const subscriptionBase = {
  version: "1",
  status: "enabled",
  transport: { method: "webhook", callback: "https://example.com/" },
  created_at: "",
};

async function fetchAs(env: AppEnv, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ログイン済みセッションを持ったユーザーを D1 に作成し、クッキーを返す
async function loginAs(
  env: AppEnv,
  userId = "12345",
): Promise<{ cookie: string; csrf: string }> {
  const enc = await import("../src/lib/crypto");
  const token = await enc.encryptSecret(env, "user-access-token");
  const refresh = await enc.encryptSecret(env, "user-refresh-token");
  await env.DB.prepare(
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
      JSON.stringify(["user:read:email"]),
    )
    .run();

  const { token: sessionToken, csrf } = await createSession(env, userId);
  return { cookie: `orbsky_session=${sessionToken}`, csrf };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM connections").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.STATE.put("twitch:webhook_secret", "webhook-secret");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("チャンネル連携ページ", () => {
  it("未ログインは / へリダイレクト", async () => {
    const res = await fetchAs(
      makeEnv(),
      new Request("https://example.com/channels"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("ログイン済みは連携一覧を表示する", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAs(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels", {
        headers: { Cookie: cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("チャンネル連携");
    expect(body).toContain("(なし)");
    expect(body).toContain("/channels/connect");
  });

  it("自分のチャンネルを連携すると一覧に表示され購読が作られる", async () => {
    let createCount = 0;
    mockFetch({
      "api.twitch.tv/helix/users": async () => jsonResponse(usersResponse),
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({
          access_token: "app-token",
          expires_in: 5000000,
          token_type: "bearer",
          scope: [],
        }),
      "eventsub/subscriptions": async (url, init) => {
        if (init?.method === "POST") {
          createCount++;
          const body = JSON.parse(String(init?.body));
          return jsonResponse({
            data: [
              {
                id: `sub-${createCount}`,
                ...subscriptionBase,
                type: body.type,
                condition: body.condition,
              },
            ],
          });
        }
        // GET(既存確認)
        return jsonResponse({ data: [] });
      },
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/connect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf }),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/channels");

    // connections に保存されている
    const { results } = await env0.DB.prepare(
      "SELECT twitch_channel_id, twitch_login FROM connections",
    ).all<{ twitch_channel_id: string; twitch_login: string }>();
    expect(results).toHaveLength(1);
    expect(results[0].twitch_channel_id).toBe("12345");

    // 購読が2件作成された(online/offline)
    expect(createCount).toBe(2);

    // 一覧に表示される
    const page = await fetchAs(
      env0,
      new Request("https://example.com/channels", {
        headers: { Cookie: cookie },
      }),
    );
    expect(await page.text()).toContain("azumagbanjo");
  });

  it("既に連携済みなら二重登録しない(既存購読はスキップ)", async () => {
    let createCount = 0;
    const createdSubs: Array<Record<string, unknown>> = [];
    mockFetch({
      "api.twitch.tv/helix/users": async () => jsonResponse(usersResponse),
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({
          access_token: "app-token",
          expires_in: 5000000,
          token_type: "bearer",
          scope: [],
        }),
      "eventsub/subscriptions": async (url, init) => {
        if (init?.method === "POST") {
          createCount++;
          const body = JSON.parse(String(init?.body));
          const sub = {
            id: `sub-${createCount}`,
            ...subscriptionBase,
            type: body.type,
            condition: body.condition,
          };
          createdSubs.push(sub);
          return jsonResponse({ data: [sub] });
        }
        // GET: 作成済みの購読を返す(2回目以降の connect はこれをスキップ判定に使う)
        return jsonResponse({ data: createdSubs });
      },
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);

    await fetchAs(
      env0,
      new Request("https://example.com/channels/connect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf }),
      }),
    );
    await fetchAs(
      env0,
      new Request("https://example.com/channels/connect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf }),
      }),
    );

    const { results } = await env0.DB.prepare(
      "SELECT COUNT(*) AS c FROM connections",
    ).all<{ c: number }>();
    expect(results[0].c).toBe(1);
    // 購読は1回目のみ作成(online/offline の2件)。2回目はスキップされる
    expect(createCount).toBe(2);
  });

  it("購読作成が409(既存)でも連携は成功扱いになる", async () => {
    mockFetch({
      "api.twitch.tv/helix/users": async () => jsonResponse(usersResponse),
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({
          access_token: "app-token",
          expires_in: 5000000,
          token_type: "bearer",
          scope: [],
        }),
      "eventsub/subscriptions": async (url, init) => {
        if (init?.method === "POST") {
          return jsonResponse(
            { error: "Conflict", message: "subscription already exists" },
            409,
          );
        }
        return jsonResponse({ data: [] });
      },
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/connect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf }),
      }),
    );
    expect(res.status).toBe(302);
    const { results } = await env0.DB.prepare(
      "SELECT COUNT(*) AS c FROM connections",
    ).all<{ c: number }>();
    expect(results[0].c).toBe(1);
  });

  it("トークン期限切れ時はエラーメッセージを表示する", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    // トークンを期限切れにする
    await env0.DB.prepare(
      "UPDATE users SET twitch_token_expires_at = ? WHERE twitch_user_id = ?",
    )
      .bind(Date.now() - 1000, "12345")
      .run();

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/connect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("再ログイン");
  });

  it("誤った CSRF では連携できない", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAs(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/connect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf: "wrong" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("無効なリクエスト");
  });

  it("連携を解除すると connections が消え購読が削除され Bluesky が解除される", async () => {
    const deletedIds: string[] = [];
    let bskyDeleteCalls = 0;
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({
          access_token: "app-token",
          expires_in: 5000000,
          token_type: "bearer",
          scope: [],
        }),
      "eventsub/subscriptions": async (url, init) => {
        if (init?.method === "DELETE") {
          deletedIds.push(String(url).split("id=")[1]);
          return new Response(null, { status: 204 });
        }
        return jsonResponse({
          data: [
            {
              id: "sub-online",
              type: "stream.online",
              condition: { broadcaster_user_id: "12345" },
              ...subscriptionBase,
            },
            {
              id: "sub-offline",
              type: "stream.offline",
              condition: { broadcaster_user_id: "12345" },
              ...subscriptionBase,
            },
          ],
        });
      },
      // Bluesky: セッション取得 + deleteRecord をモック
      "com.atproto.server.createSession": async () =>
        jsonResponse({
          accessJwt: "bsky-jwt",
          did: "did:plc:test",
        }),
      "com.atproto.repo.deleteRecord": async () => {
        bskyDeleteCalls++;
        return jsonResponse({ commit: { cid: "x", rev: "1" } });
      },
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);

    // 事前に連携を作成
    const inserted = await env0.DB.prepare(
      `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES (?, ?, ?, ?)`,
    )
      .bind("12345", "12345", "azumagbanjo", "あずまぐ")
      .run();
    const connectionId = inserted.meta.last_row_id;

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/disconnect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf, connection_id: String(connectionId) }),
      }),
    );
    expect(res.status).toBe(302);

    const { results } = await env0.DB.prepare(
      "SELECT COUNT(*) AS c FROM connections",
    ).all<{ c: number }>();
    expect(results[0].c).toBe(0);

    // 購読削除が呼ばれた
    expect(deletedIds.sort()).toEqual(["sub-offline", "sub-online"]);
    // Bluesky ステータス解除が呼ばれた
    expect(bskyDeleteCalls).toBeGreaterThan(0);
  });

  it("disconnect の誤った CSRF は拒否される", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAs(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/disconnect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf: "wrong", connection_id: "1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("無効なリクエスト");
  });

  it("disconnect は他ユーザーの connection を削除できない", async () => {
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({
          access_token: "app-token",
          expires_in: 5000000,
          token_type: "bearer",
          scope: [],
        }),
      "eventsub/subscriptions": async () => jsonResponse({ data: [] }),
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);

    // 別ユーザー(99999)の connection を作成
    const inserted = await env0.DB.prepare(
      `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES (?, ?, ?, ?)`,
    )
      .bind("99999", "99999", "other", "他人")
      .run();

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/disconnect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf,
          connection_id: String(inserted.meta.last_row_id),
        }),
      }),
    );
    expect(res.status).toBe(302);

    const { results } = await env0.DB.prepare(
      "SELECT COUNT(*) AS c FROM connections WHERE user_id = '99999'",
    ).all<{ c: number }>();
    expect(results[0].c).toBe(1); // 削除されていない
  });
});
