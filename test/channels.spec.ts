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

const blueskyModule = await import("../src/lib/bluesky");
vi.mock("../src/lib/bluesky", () => ({
  clearLiveStatus: vi.fn(async () => {}),
  getSessionForUser: vi.fn(async () => ({
    did: "did:plc:test",
    fetchHandler: async () => new Response(),
  })),
}));
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

async function grantSupportEntitlement(
  env0: AppEnv,
  userId = "12345",
): Promise<void> {
  const code = "MULTI-CHANNEL-CODE";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code),
  );
  const codeHash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await env0.DB.prepare(
    "INSERT INTO support_codes (code_hash, plan_type) VALUES (?, 'support')",
  )
    .bind(codeHash)
    .run();
  const { activateCode } = await import("../src/lib/support");
  await activateCode(env0, userId, code);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM connections").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM user_licenses").run();
  await env.DB.prepare("DELETE FROM support_codes").run();
  await env.STATE.put("twitch:webhook_secret", "webhook-secret");
  await env.STATE.delete("twitch:token");
  vi.mocked(blueskyModule.clearLiveStatus).mockReset();
  vi.mocked(blueskyModule.getSessionForUser).mockReset();
  vi.mocked(blueskyModule.getSessionForUser).mockResolvedValue({
    did: "did:plc:test",
    fetchHandler: async () => new Response(),
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("チャネル連携ページ", () => {
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
    await env0.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('12345', '12345', 'azumagbanjo', 'あずまぐ')`,
    ).run();

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels", {
        headers: { Cookie: cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("チャネル連携");
    expect(body).not.toContain("自分のチャネルを連携する");
    expect(body).toContain("マルチチャネル");
    expect(body).toContain("複数のチャネルからの通知を受け取るには");
    expect(body).not.toContain('name="channel_login"');
  });

  it("自分のチャネルが未連携なら再連携カードを表示する", async () => {
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
    expect(body).toContain("自分のチャネルを連携し直す");
    expect(body).toContain('action="/channels/connect"');
  });

  it("特典ユーザーにはマルチチャネル追加フォームを表示する", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAs(env0);
    await grantSupportEntitlement(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels", {
        headers: { Cookie: cookie },
      }),
    );
    const body = await res.text();

    expect(body).toContain('action="/channels/add"');
    expect(body).toContain('name="channel_login"');
    expect(body).toContain("例: azumagsandbox");
    expect(body).toContain("チャネルを追加");
    expect(body).not.toContain("特典を有効化する");
  });

  it("連携チャネルごとの自動ポスト設定を表示する", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAs(env0);
    await env0.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('12345', '12345', 'azumagbanjo', 'あずまぐ')`,
    ).run();

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels", {
        headers: { Cookie: cookie },
      }),
    );
    const body = await res.text();

    expect(body).toContain('action="/channels/posting"');
    expect(body).toContain('name="post_on_start" value="1" checked');
    expect(body).toContain('name="post_template"');
    expect(body).toContain("{title}");
    expect(body).toContain("{category}");
    expect(body).toContain("{channel}");
    expect(body).toContain("{url}");
    expect(body).toContain("すべてのプランで利用できます");
    expect(body).toContain('class="page-shell channels-page"');
    expect(body).toContain("data-channel-panel");
    expect(body).toContain("data-posting-form");
    expect(body).toContain("data-preview-text");
    expect(body).toContain('role="switch"');
    expect(body).toContain("management-section");
    // マルチチャネルとチャネル管理は最初から開いた状態で表示する
    expect(body).not.toContain("<details class=\"management-disclosure\"");
    expect(body).not.toContain("<details class=\"channel-actions\"");
    expect(body).toContain('class="channel-actions"');
    expect(body).toContain("連携を解除");
    expect(body).toContain("data-post-on-start-status");
    expect(body).not.toContain('class="progress-strip"');
    expect(body).not.toContain('role="tablist"');
    expect(body).not.toContain('class="channel-tab');
    expect(body).not.toContain("include_title");
    expect(body).not.toContain("include_category");
  });

  it("複数チャネルのときだけチャネル選択タブを表示する", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAs(env0);
    await env0.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('12345', '12345', 'azumagbanjo', 'あずまぐ'),
              ('12345', '67890', 'azumagsandbox', 'azumagsandbox')`,
    ).run();

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels", {
        headers: { Cookie: cookie },
      }),
    );
    const body = await res.text();

    expect(body).toContain("編集するチャネル");
    expect(body).toContain('role="tablist"');
    expect(body).toContain('class="channel-tab');
    expect(body).toContain("azumagsandbox");
  });

  it("無料ユーザーでもチャネル別の投稿本文設定を保存できる", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    const inserted = await env0.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('12345', '12345', 'azumagbanjo', 'あずまぐ')`,
    ).run();
    const connectionId = Number(inserted.meta.last_row_id);
    const postTemplate = "🔴 {channel} 配信開始\n{title}\nカテゴリ: {category}\n{url}";

    const update = await fetchAs(
      env0,
      new Request("https://example.com/channels/posting", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf,
          connection_id: String(connectionId),
          post_on_start: "1",
          post_template: postTemplate,
        }),
      }),
    );
    expect(update.status).toBe(302);
    expect(update.headers.get("Location")).toBe(
      `/channels?posting=saved#channel-${connectionId}`,
    );

    const row = await env0.DB.prepare(
      `SELECT post_on_start AS enabled, post_template AS postTemplate
       FROM connections WHERE id = ?`,
    )
      .bind(connectionId)
      .first<{ enabled: number; postTemplate: string }>();
    expect(row).toEqual({ enabled: 1, postTemplate });

    const saved = await fetchAs(
      env0,
      new Request("https://example.com/channels?posting=saved", {
        headers: { Cookie: cookie },
      }),
    );
    expect(await saved.text()).toContain("自動ポスト設定を保存しました");
  });

  it("チャネル別の自動ポストをOFFにできる", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    const inserted = await env0.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('12345', '12345', 'azumagbanjo', 'あずまぐ')`,
    ).run();
    const connectionId = Number(inserted.meta.last_row_id);

    const update = await fetchAs(
      env0,
      new Request("https://example.com/channels/posting", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf,
          connection_id: String(connectionId),
          post_template: "配信開始しました",
        }),
      }),
    );
    expect(update.status).toBe(302);

    const row = await env0.DB.prepare(
      "SELECT post_on_start AS enabled FROM connections WHERE id = ?",
    )
      .bind(connectionId)
      .first<{ enabled: number }>();
    expect(row?.enabled).toBe(0);
  });

  it("トグルだけの送信は投稿文を変えずに即時保存され204を返す", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    const inserted = await env0.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name, post_on_start, post_template)
       VALUES ('12345', '12345', 'azumagbanjo', 'あずまぐ', 0, '元の本文')`,
    ).run();
    const connectionId = Number(inserted.meta.last_row_id);

    const on = await fetchAs(
      env0,
      new Request("https://example.com/channels/posting", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf,
          connection_id: String(connectionId),
          only: "post_on_start",
          post_on_start: "1",
        }),
      }),
    );
    expect(on.status).toBe(204);
    const afterOn = await env0.DB.prepare(
      `SELECT post_on_start AS enabled, post_template AS postTemplate
       FROM connections WHERE id = ?`,
    )
      .bind(connectionId)
      .first<{ enabled: number; postTemplate: string }>();
    expect(afterOn).toEqual({ enabled: 1, postTemplate: "元の本文" });

    const off = await fetchAs(
      env0,
      new Request("https://example.com/channels/posting", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf,
          connection_id: String(connectionId),
          only: "post_on_start",
        }),
      }),
    );
    expect(off.status).toBe(204);
    const afterOff = await env0.DB.prepare(
      `SELECT post_on_start AS enabled, post_template AS postTemplate
       FROM connections WHERE id = ?`,
    )
      .bind(connectionId)
      .first<{ enabled: number; postTemplate: string }>();
    expect(afterOff).toEqual({ enabled: 0, postTemplate: "元の本文" });
  });

  it("他ユーザーのチャネルはトグルだけの送信でも変更されない", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    const inserted = await env0.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name, post_on_start)
       VALUES ('other-user', '99999', 'other_channel', '別チャネル', 0)`,
    ).run();
    const connectionId = Number(inserted.meta.last_row_id);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/posting", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf,
          connection_id: String(connectionId),
          only: "post_on_start",
          post_on_start: "1",
        }),
      }),
    );
    expect(res.status).toBe(404);
    const row = await env0.DB.prepare(
      "SELECT post_on_start AS enabled FROM connections WHERE id = ?",
    )
      .bind(connectionId)
      .first<{ enabled: number }>();
    expect(row?.enabled).toBe(0);
  });

  it("CSRF不一致と他ユーザーのチャネル更新を拒否する", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    const inserted = await env0.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('other-user', '99999', 'other_channel', '別チャネル')`,
    ).run();
    const connectionId = Number(inserted.meta.last_row_id);
    const requestBody = {
      connection_id: String(connectionId),
      post_template: "変更されない本文",
    };

    const csrfRejected = await fetchAs(
      env0,
      new Request("https://example.com/channels/posting", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf: "wrong", ...requestBody }),
      }),
    );
    expect(await csrfRejected.text()).toContain("無効なリクエスト");

    const ownerRejected = await fetchAs(
      env0,
      new Request("https://example.com/channels/posting", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf, ...requestBody }),
      }),
    );
    expect(await ownerRejected.text()).toContain("チャネル設定を保存できません");

    const row = await env0.DB.prepare(
      "SELECT post_template AS postTemplate FROM connections WHERE id = ?",
    )
      .bind(connectionId)
      .first<{ postTemplate: string }>();
    expect(row?.postTemplate).not.toBe("変更されない本文");
  });

  it("未対応のテンプレート変数を拒否する", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    const inserted = await env0.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('12345', '12345', 'azumagbanjo', 'あずまぐ')`,
    ).run();

    const update = await fetchAs(
      env0,
      new Request("https://example.com/channels/posting", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf,
          connection_id: String(inserted.meta.last_row_id),
          post_template: "{unknown}",
        }),
      }),
    );
    expect(await update.text()).toContain("使用できない変数です");
  });

  it("自分のチャネルを連携すると一覧に表示され購読が作られる", async () => {
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

  it("トークン期限切れ時はリフレッシュしてから連携できる", async () => {
    let refreshCalls = 0;
    mockFetch({
      "api.twitch.tv/helix/users": async (url, init) => {
        // リフレッシュ後の新トークンで呼ばれる
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer refreshed-token",
        });
        return jsonResponse(usersResponse);
      },
      "id.twitch.tv/oauth2/token": async (url, init) => {
        const body = String(init?.body);
        if (body.includes("grant_type=refresh_token")) {
          refreshCalls++;
          return jsonResponse({
            access_token: "refreshed-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
            scope: ["user:read:email"],
            token_type: "bearer",
          });
        }
        if (body.includes("grant_type=client_credentials")) {
          return jsonResponse({
            access_token: "app-token",
            expires_in: 5000000,
            token_type: "bearer",
            scope: [],
          });
        }
        throw new Error("unexpected grant_type");
      },
      "eventsub/subscriptions": async () => jsonResponse({ data: [] }),
    });
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
    expect(res.status).toBe(302);
    expect(refreshCalls).toBe(1);

    // 新しいトークンが保存されている
    const row = await env0.DB.prepare(
      "SELECT twitch_refresh_token_enc AS r FROM users WHERE twitch_user_id = ?",
    )
      .bind("12345")
      .first<{ r: string }>();
    expect(row?.r).toBeTruthy();
    expect(row!.r).not.toContain("new-refresh-token"); // 暗号化されている
  });

  it("リフレッシュも失敗したら再ログインを促す", async () => {
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({ error: "invalid_grant", message: "refresh token expired" }, 400),
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
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

  it("自分のチャネル連携は特典の有無に関わらず成功する", async () => {
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
          const body = JSON.parse(String(init?.body));
          return jsonResponse({
            data: [{ id: "sub-1", ...subscriptionBase, type: body.type, condition: body.condition }],
          });
        }
        return jsonResponse({ data: [] });
      },
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);

    // 1件目(別チャネル)を先に連携しておく
    await env0.DB.prepare(
      `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('12345', '99999', 'other', '別チャネル')`,
    ).run();

    // 特典を持たない無料ユーザーでも、自分自身のチャネル連携は成功する
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
    expect(results[0].c).toBe(2);
  });

  it("特典(Fanboxコード)ユーザーは複数チャネルを連携できる", async () => {
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
              { id: `sub-${createCount}`, ...subscriptionBase, type: body.type, condition: body.condition },
            ],
          });
        }
        return jsonResponse({ data: [] });
      },
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);

    // Fanbox コードで特典を付与
    const codeHash = await (async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("GATE-CODE"),
      );
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    })();
    await env0.DB.prepare(
      "INSERT INTO support_codes (code_hash, plan_type) VALUES (?, 'support')",
    )
      .bind(codeHash)
      .run();
    const { activateCode } = await import("../src/lib/support");
    await activateCode(env0, "12345", "GATE-CODE");

    // 1件目 + 2件目(自分のチャネル)を連携 → 両方成功
    await env0.DB.prepare(
      `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('12345', '99999', 'other', '別チャネル')`,
    ).run();

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
    expect(results[0].c).toBe(2);
  });

  it("特典ユーザーはTwitchユーザー名で別チャネルを追加できる", async () => {
    let createCount = 0;
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({
          access_token: "app-token",
          expires_in: 5000000,
          token_type: "bearer",
          scope: [],
        }),
      "api.twitch.tv/helix/users?login=azumagsandbox": async (url, init) => {
        expect(url.searchParams.get("login")).toBe("azumagsandbox");
        expect(init?.headers).toMatchObject({
          "Client-ID": "test-client-id",
          Authorization: "Bearer app-token",
        });
        return jsonResponse({
          data: [
            {
              id: "742412446",
              login: "azumagsandbox",
              display_name: "azumagsandbox",
              profile_image_url: "https://example.com/sandbox.png",
            },
          ],
        });
      },
      "eventsub/subscriptions": async (url, init) => {
        if (init?.method === "POST") {
          createCount++;
          const body = JSON.parse(String(init.body));
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
        return jsonResponse({ data: [] });
      },
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    await grantSupportEntitlement(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/add", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf,
          channel_login: "@AzumagSandbox",
        }),
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/channels");
    const row = await env0.DB.prepare(
      `SELECT user_id AS userId, twitch_channel_id AS channelId,
              twitch_login AS login, twitch_display_name AS displayName
       FROM connections WHERE user_id = ?`,
    )
      .bind("12345")
      .first<{
        userId: string;
        channelId: string;
        login: string;
        displayName: string;
      }>();
    expect(row).toEqual({
      userId: "12345",
      channelId: "742412446",
      login: "azumagsandbox",
      displayName: "azumagsandbox",
    });
    expect(createCount).toBe(2);
  });

  it("無料ユーザーはチャネル追加POSTを直接送っても拒否される", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    await env0.DB.prepare(
      "UPDATE users SET twitch_sub_check_disabled = 1 WHERE twitch_user_id = ?",
    )
      .bind("12345")
      .run();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/add", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf, channel_login: "azumagsandbox" }),
      }),
    );

    expect(await res.text()).toContain("マルチチャネルの有効化が必要");
    expect(fetchMock).not.toHaveBeenCalled();
    const count = await env0.DB.prepare(
      "SELECT COUNT(*) AS count FROM connections",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("存在しないTwitchユーザー名は追加しない", async () => {
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({
          access_token: "app-token",
          expires_in: 5000000,
          token_type: "bearer",
          scope: [],
        }),
      "api.twitch.tv/helix/users?login=missing": async () =>
        jsonResponse({ data: [] }),
    });
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    await grantSupportEntitlement(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/channels/add", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf, channel_login: "missing" }),
      }),
    );

    expect(await res.text()).toContain("Twitchチャネルが見つかりません");
    const count = await env0.DB.prepare(
      "SELECT COUNT(*) AS count FROM connections",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("不正形式のTwitchユーザー名と誤ったCSRFを拒否する", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAs(env0);
    await grantSupportEntitlement(env0);

    const invalidLogin = await fetchAs(
      env0,
      new Request("https://example.com/channels/add", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf,
          channel_login: "https://twitch.tv/example",
        }),
      }),
    );
    expect(await invalidLogin.text()).toContain(
      "Twitchユーザー名を正しく入力",
    );

    const invalidCsrf = await fetchAs(
      env0,
      new Request("https://example.com/channels/add", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          csrf: "wrong",
          channel_login: "azumagsandbox",
        }),
      }),
    );
    expect(await invalidCsrf.text()).toContain("無効なリクエスト");
  });

  it("連携を解除すると connections が消え購読が削除され Bluesky が解除される", async () => {
    const deletedIds: string[] = [];
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
    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
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
