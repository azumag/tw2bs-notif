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
import { WebcryptoKey } from "@atproto/jwk-webcrypto";
import {
  BSKY_CLIENT_METADATA,
  bindBskySessionToUser,
  createD1SessionStore,
  createKvStateStore,
  disconnectBsky,
  getBskyDidForUser,
} from "../src/lib/bsky-oauth";

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

async function fetchAs(env0: AppEnv, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env0, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function loginAndGetCookie(
  env0: AppEnv,
): Promise<{ cookie: string; csrf: string }> {
  const { token: sessionToken, csrf } = await createSession(env0, "user-1");
  return { cookie: `orbsky_session=${sessionToken}`, csrf };
}

// テスト用のフェイクセッション(D1 ストアの round-trip 用)
async function makeFakeSessionData() {
  const dpopKey = await WebcryptoKey.generate(["ES256"], crypto.randomUUID(), {
    extractable: true,
  });
  return {
    dpopKey,
    authMethod: "none" as const,
    tokenSet: {
      access_token: "at-1",
      refresh_token: "rt-1",
      scope: "atproto",
      token_type: "DPoP",
      expires_at: Date.now() + 60_000,
    },
  };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM bsky_sessions").run();
  await env.DB.prepare("DELETE FROM users").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("クライアントメタデータ", () => {
  it("クライアントメタデータが公開される", async () => {
    const res = await fetchAs(
      makeEnv(),
      new Request("https://example.com/oauth-client-metadata.json"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof BSKY_CLIENT_METADATA;
    expect(body.client_id).toBe(BSKY_CLIENT_METADATA.client_id);
    expect(body.scope).toContain("repo:app.bsky.actor.status");
    expect(body.scope).toContain("repo:app.bsky.feed.post");
    expect(body.redirect_uris).toContain(
      "https://orbsky.bluemoon.works/auth/bluesky/callback",
    );
    expect(body.dpop_bound_access_tokens).toBe(true);
  });
});

describe("D1 セッションストア", () => {
  it("セッションを暗号化して保存・復元できる(DPoP 鍵含む)", async () => {
    const env0 = makeEnv();
    const store = createD1SessionStore(env0);
    const data = await makeFakeSessionData();

    await store.set("did:plc:test", data as never);
    const restored = (await store.get("did:plc:test")) as unknown as typeof data;

    expect(restored.authMethod).toBe("none");
    expect(restored.tokenSet.access_token).toBe("at-1");
    // DPoP 鍵が復元されている(privateJwk を持ち、署名可能)
    expect(restored.dpopKey.privateJwk).toBeTruthy();

    // D1 には暗号化して保存されている
    const row = await env0.DB.prepare(
      "SELECT session_json_enc AS enc FROM bsky_sessions WHERE did = ?",
    )
      .bind("did:plc:test")
      .first<{ enc: string }>();
    expect(row?.enc).toContain("v1:");
    expect(row!.enc).not.toContain("at-1");

    await store.del("did:plc:test");
    await expect(store.get("did:plc:test")).resolves.toBeUndefined();
  });
});

describe("KV ステートストア", () => {
  it("認可フロー中の state を保存・削除できる", async () => {
    const env0 = makeEnv();
    const store = createKvStateStore(env0);
    const data = await makeFakeSessionData();

    await store.set("state-1", data as never);
    const restored = (await store.get("state-1")) as unknown as typeof data;
    expect(restored.tokenSet.access_token).toBe("at-1");
    expect(restored.dpopKey.privateJwk).toBeTruthy();

    await store.del("state-1");
    await expect(store.get("state-1")).resolves.toBeUndefined();
  });
});

describe("ユーザーとの紐付け", () => {
  it("セッションを Twitch ユーザーに紐付けられる", async () => {
    const env0 = makeEnv();
    const store = createD1SessionStore(env0);
    const data = await makeFakeSessionData();
    await store.set("did:plc:test", data as never);

    await bindBskySessionToUser(env0, "user-1", "did:plc:test");
    await expect(getBskyDidForUser(env0, "user-1")).resolves.toBe(
      "did:plc:test",
    );
  });

  it("disconnect でセッションが削除される", async () => {
    const env0 = makeEnv();
    const store = createD1SessionStore(env0);
    const data = await makeFakeSessionData();
    await store.set("did:plc:test", data as never);
    await bindBskySessionToUser(env0, "user-1", "did:plc:test");

    await disconnectBsky(env0, "user-1");

    await expect(getBskyDidForUser(env0, "user-1")).resolves.toBeNull();
    await expect(store.get("did:plc:test")).resolves.toBeUndefined();
  });
});

describe("設定ページと連携ルート", () => {
  it("未ログインは / へリダイレクト", async () => {
    const res = await fetchAs(
      makeEnv(),
      new Request("https://example.com/settings"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("未連携の設定ページは連携フォームを表示する", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAndGetCookie(env0);
    const res = await fetchAs(
      env0,
      new Request("https://example.com/settings", {
        headers: { Cookie: cookie },
      }),
    );
    const body = await res.text();
    expect(body).toContain("Bluesky連携");
    expect(body).toContain("未連携");
    expect(body).toContain("/auth/bluesky/login");
  });

  it("連携済みの設定ページは DID と解除ボタンを表示する", async () => {
    const env0 = makeEnv();
    const store = createD1SessionStore(env0);
    const data = await makeFakeSessionData();
    await store.set("did:plc:test", data as never);
    await bindBskySessionToUser(env0, "user-1", "did:plc:test");
    const { cookie } = await loginAndGetCookie(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/settings", {
        headers: { Cookie: cookie },
      }),
    );
    const body = await res.text();
    expect(body).toContain("did:plc:test");
    expect(body).toContain("/auth/bluesky/disconnect");
  });

  it("ハンドルなしのログインはエラー", async () => {
    const env0 = makeEnv();
    const { cookie } = await loginAndGetCookie(env0);
    const res = await fetchAs(
      env0,
      new Request("https://example.com/auth/bluesky/login", {
        headers: { Cookie: cookie },
      }),
    );
    expect(await res.text()).toContain("ハンドル");
  });

  it("disconnect は CSRF 検証後にセッションを削除する", async () => {
    const env0 = makeEnv();
    const store = createD1SessionStore(env0);
    const data = await makeFakeSessionData();
    await store.set("did:plc:test", data as never);
    await bindBskySessionToUser(env0, "user-1", "did:plc:test");
    const { cookie, csrf } = await loginAndGetCookie(env0);

    const res = await fetchAs(
      env0,
      new Request("https://example.com/auth/bluesky/disconnect", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf }),
      }),
    );
    expect(res.status).toBe(302);
    await expect(getBskyDidForUser(env0, "user-1")).resolves.toBeNull();
  });
});
