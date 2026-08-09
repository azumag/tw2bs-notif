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
  activateCode,
  deactivateEntitlements,
  hasActiveEntitlement,
  listEntitlements,
} from "../src/lib/support";

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

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function insertCode(
  env0: AppEnv,
  code: string,
  planType: string,
  status = "active",
) {
  const codeHash = await sha256Hex(code);
  return env0.DB.prepare(
    `INSERT INTO support_codes (code_hash, plan_type, status)
     VALUES (?, ?, ?)`,
  )
    .bind(codeHash, planType, status)
    .run();
}

async function loginAndGetCookie(
  env0: AppEnv,
): Promise<{ cookie: string; csrf: string }> {
  const { token: sessionToken, csrf } = await createSession(env0, "user-1");
  return { cookie: `orbsky_session=${sessionToken}`, csrf };
}

async function fetchAs(env0: AppEnv, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env0, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user_licenses").run();
  await env.DB.prepare("DELETE FROM support_codes").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("support モジュール", () => {
  it("有効なコードでライセンスが付与され activation_count が増える", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-001", "support");

    const license = await activateCode(env0, "user-1", "CODE-001");

    expect(license.planType).toBe("support");
    const licenses = await listEntitlements(env0, "user-1");
    expect(licenses).toHaveLength(1);
    expect(licenses[0].planType).toBe("support");

    const row = await env0.DB.prepare(
      "SELECT activation_count AS c FROM support_codes WHERE code_hash = ?",
    )
      .bind(await sha256Hex("CODE-001"))
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
  });

  it("コードは複数ユーザーで共有可能(ユーザーごとに1回)", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-001", "support");

    await activateCode(env0, "user-1", "CODE-001");
    const license2 = await activateCode(env0, "user-2", "CODE-001");

    expect(license2.planType).toBe("support");
    const licenses1 = await listEntitlements(env0, "user-1");
    const licenses2 = await listEntitlements(env0, "user-2");
    expect(licenses1).toHaveLength(1);
    expect(licenses2).toHaveLength(1);

    // activation_count は利用ユーザー数分増える(2)
    const row = await env0.DB.prepare(
      "SELECT activation_count AS c FROM support_codes WHERE code_hash = ?",
    )
      .bind(await sha256Hex("CODE-001"))
      .first<{ c: number }>();
    expect(row?.c).toBe(2);
  });

  it("同一ユーザーの同じコード再入力は ALREADY_ACTIVATED で二重付与しない", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-001", "support");

    await activateCode(env0, "user-1", "CODE-001");
    await expect(
      activateCode(env0, "user-1", "CODE-001"),
    ).rejects.toThrow("すでに利用済み");

    const licenses = await listEntitlements(env0, "user-1");
    expect(licenses).toHaveLength(1);
    const row = await env0.DB.prepare(
      "SELECT activation_count AS c FROM support_codes WHERE code_hash = ?",
    )
      .bind(await sha256Hex("CODE-001"))
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
  });

  it("同一コードの並行アクティベートで activation_count が二重加算されない", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-001", "support");

    // 並行に2回呼ぶ(D1 は直列実行されるが、レース構造の検証)
    const results = await Promise.allSettled([
      activateCode(env0, "user-1", "CODE-001"),
      activateCode(env0, "user-1", "CODE-001"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // 少なくとも1つは成功(どちらかが ALREADY になる場合もある)
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const licenses = await listEntitlements(env0, "user-1");
    expect(licenses).toHaveLength(1);

    const row = await env0.DB.prepare(
      "SELECT activation_count AS c FROM support_codes WHERE code_hash = ?",
    )
      .bind(await sha256Hex("CODE-001"))
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
  });

  it("fanbox_id 付きで activate できる", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-001", "support");

    const license = await activateCode(env0, "user-1", "CODE-001", "fanbox-123");
    expect(license.fanboxId).toBe("fanbox-123");

    const licenses = await listEntitlements(env0, "user-1");
    expect(licenses[0].fanboxId).toBe("fanbox-123");
  });

  it("無効なコードは INVALID_CODE", async () => {
    await expect(
      activateCode(makeEnv(), "user-1", "NO-SUCH-CODE"),
    ).rejects.toThrow("コードが正しくありません");
  });

  it("inactive なコードは INACTIVE_CODE", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-002", "support", "inactive");
    await expect(
      activateCode(env0, "user-1", "CODE-002"),
    ).rejects.toThrow("利用できません");
  });

  it("上位プラン(patron)のコードで置き換えられる", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-S", "support");
    await insertCode(env0, "CODE-P", "patron");

    await activateCode(env0, "user-1", "CODE-S");
    const license = await activateCode(env0, "user-1", "CODE-P");
    expect(license.planType).toBe("patron");

    const licenses = await listEntitlements(env0, "user-1");
    expect(licenses).toHaveLength(1);
    expect(licenses[0].planType).toBe("patron");
  });

  it("下位プランのコードを入力しても既存(上位)を維持する", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-S", "support");
    await insertCode(env0, "CODE-P", "patron");

    await activateCode(env0, "user-1", "CODE-P");
    const license = await activateCode(env0, "user-1", "CODE-S");
    expect(license.planType).toBe("patron");

    const licenses = await listEntitlements(env0, "user-1");
    expect(licenses).toHaveLength(1);
    expect(licenses[0].planType).toBe("patron");
  });

  it("解除するとライセンスが消える", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-001", "support");
    await activateCode(env0, "user-1", "CODE-001");

    await deactivateEntitlements(env0, "user-1");
    await expect(hasActiveEntitlement(env0, "user-1")).resolves.toBe(false);
  });

  it("hasActiveEntitlement はライセンス有無を返す", async () => {
    const env0 = makeEnv();
    await expect(hasActiveEntitlement(env0, "user-1")).resolves.toBe(false);
    await insertCode(env0, "CODE-001", "support");
    await activateCode(env0, "user-1", "CODE-001");
    await expect(hasActiveEntitlement(env0, "user-1")).resolves.toBe(true);
  });
});

describe("サポートページ(HTTP)", () => {
  it("未ログインは / へリダイレクト", async () => {
    const res = await fetchAs(
      makeEnv(),
      new Request("https://example.com/support"),
    );
    expect(res.status).toBe(302);
  });

  it("ログイン済みはマルチチャネル有効化ページを表示する", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAndGetCookie(env0);
    const res = await fetchAs(
      env0,
      new Request("https://example.com/support", {
        headers: { Cookie: cookie },
      }),
    );
    const body = await res.text();
    // 利用状況は有効/無効のバッジだけを示す
    expect(body).toContain("status-badge");
    expect(body).toContain(">無効</span>");
    expect(body).not.toContain("無料利用では1チャネルまで連携できます");
    // 有効化する方法の説明が、入力欄より先に出る
    const methodsAt = body.indexOf("有効化する方法");
    const codeFormAt = body.indexOf('action="/support/activate"');
    const subFormAt = body.indexOf('action="/support/check-subscription"');
    expect(methodsAt).toBeGreaterThan(-1);
    expect(codeFormAt).toBeGreaterThan(methodsAt);
    expect(subFormAt).toBeGreaterThan(methodsAt);
    expect(body).toContain("マルチチャネル機能とは");
    // 有料機能ではなく返礼の特典であること、制限理由を明示する
    expect(body).toContain("これは有料機能ではありません");
    expect(body).toContain("返礼としての特典");
    expect(body).toContain("なぜチャネル数を制限しているのか");
    expect(body).toContain("サーバー負荷");
    expect(body).toContain("サポートコードで有効化");
    expect(body).toContain("Twitchサブスクで有効化");
    expect(body).toContain("複数のTwitchチャネル");
    expect(body).toContain("サポーター");
    expect(body).toContain("パトロン");
    expect(body).toContain("FANBOXのメッセージまたは支援者向け投稿");
    expect(body).toContain('href="https://azumag.fanbox.cc/"');
    expect(body).toContain("別サービス");
    expect(body).toContain('href="https://twica.bluemoon.works/plans"');
    expect(body).toContain("同一のものをご利用いただけます");
    // サブスク確認ボタンには azumagbanjo のTwitchリンクを添える
    expect(body).toContain('href="https://www.twitch.tv/azumagbanjo"');
    // 説明文中の @azumagbanjo もTwitchチャネルへのリンクにする
    expect(body).toContain(
      '<a href="https://www.twitch.tv/azumagbanjo" target="_blank" rel="noopener noreferrer">@azumagbanjo</a>',
    );
    expect(body).toContain('rel="noopener noreferrer"');
    expect(body).toContain("(なし)");
  });

  it("コード入力で有効化される(HTTP)", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-001", "support");
    const { cookie, csrf } = await loginAndGetCookie(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/support/activate", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf, code: "CODE-001" }),
      }),
    );
    const body = await res.text();
    expect(body).toContain("有効化しました");
    expect(body).toContain("プラン: サポーター");
    expect(body).toContain('href="/channels"');
    expect(body).toContain("チャネル設定を開く");

    const licenses = await listEntitlements(env0, "user-1");
    expect(licenses).toHaveLength(1);

    const channels = await fetchAs(
      env0,
      new Request("https://example.com/channels", {
        headers: { Cookie: cookie },
      }),
    );
    const channelsBody = await channels.text();
    expect(channelsBody).toContain('action="/channels/add"');
    expect(channelsBody).toContain('name="channel_login"');
  });

  it("無効なコードはエラーメッセージを表示する(HTTP)", async () => {
    const env0 = makeEnv();
    const { cookie, csrf } = await loginAndGetCookie(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/support/activate", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf, code: "BAD" }),
      }),
    );
    expect(await res.text()).toContain("コードが正しくありません");
  });

  it("CSRF 不一致は拒否される(HTTP)", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAndGetCookie(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/support/activate", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf: "wrong", code: "CODE-001" }),
      }),
    );
    expect(await res.text()).toContain("無効なリクエスト");
  });

  it("特典解除ができる(HTTP)", async () => {
    const env0 = makeEnv();
    await insertCode(env0, "CODE-001", "support");
    const { cookie, csrf } = await loginAndGetCookie(env0);
    await activateCode(env0, "user-1", "CODE-001");

    const res = await fetchAs(
      env0,
      new Request("https://example.com/support/deactivate", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf }),
      }),
    );
    expect(res.status).toBe(302);
    await expect(hasActiveEntitlement(env0, "user-1")).resolves.toBe(false);
  });
});
