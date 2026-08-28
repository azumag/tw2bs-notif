import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebcryptoKey } from "@atproto/jwk-webcrypto";
import worker from "../src/worker";
import type { AppEnv } from "../src/types";
import { migrations } from "./migrations";
import {
  BSKY_CLIENT_METADATA,
  BSKY_JWKS_PATH,
  bindBskySessionToUser,
  createD1RequestLock,
  createD1SessionStore,
  getBskyConnectionForUser,
  getBskyDidForUser,
  getBskyPublicJwks,
  getOAuthClient,
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

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM bsky_oauth_locks").run();
  await env.DB.prepare("DELETE FROM bsky_oauth_events").run();
  await env.DB.prepare("DELETE FROM bsky_connections").run();
  await env.DB.prepare("DELETE FROM bsky_sessions").run();
  await env.DB.prepare("DELETE FROM users").run();
});

describe("confidential client metadata と JWKS", () => {
  it("private_key_jwt と公開 JWKS URI を広告する", () => {
    expect(BSKY_CLIENT_METADATA.token_endpoint_auth_method).toBe(
      "private_key_jwt",
    );
    expect(BSKY_CLIENT_METADATA.token_endpoint_auth_signing_alg).toBe("ES256");
    expect(BSKY_CLIENT_METADATA.jwks_uri).toBe(
      "https://orbsky.bluemoon.works/oauth-jwks.json",
    );
  });

  it("署名鍵を一度だけ生成し、秘密値を含まない公開 JWKS を返す", async () => {
    const env0 = makeEnv();
    const first = await getBskyPublicJwks(env0);
    const second = await getBskyPublicJwks(env0);

    expect(first.keys).toHaveLength(1);
    expect(first.keys[0].kid).toBeTruthy();
    expect(first.keys[0].alg).toBe("ES256");
    expect(JSON.stringify(first.keys[0])).not.toContain('"d"');
    expect(second.keys[0].kid).toBe(first.keys[0].kid);

    const row = await env0.DB.prepare(
      `SELECT private_jwk_enc AS enc
       FROM bsky_oauth_client_keys WHERE key_name = 'primary'`,
    ).first<{ enc: string }>();
    expect(row?.enc).toContain("v1:");
    expect(row?.enc).not.toContain('"d"');
  });

  it("本番 Worker の JWKS エンドポイントも公開鍵だけを返す", async () => {
    const res = await fetchAs(
      makeEnv(),
      new Request(`https://example.com${BSKY_JWKS_PATH}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].kid).toBeTruthy();
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("OAuthClient の署名 keyset と JWKS の kid が一致する", async () => {
    const env0 = makeEnv();
    const jwks = await getBskyPublicJwks(env0);
    const client = await getOAuthClient(env0);
    expect(client.jwks?.keys[0]?.kid).toBe(jwks.keys[0].kid);
  });
});


describe("OAuth移行スキーマの後方互換性", () => {
  it("migration先行中も旧Worker形式で保存でき、新WorkerのNULL紐付けも複数保存できる", async () => {
    const env0 = makeEnv();
    await env0.DB.prepare(
      `INSERT INTO bsky_sessions (did, twitch_user_id, session_json_enc)
       VALUES ('did:plc:legacy', '', 'legacy-enc')`,
    ).run();
    await env0.DB.prepare(
      `INSERT INTO bsky_sessions (did, session_json_enc) VALUES
         ('did:plc:new-1', 'new-enc-1'),
         ('did:plc:new-2', 'new-enc-2')`,
    ).run();

    const rows = await env0.DB.prepare(
      `SELECT did, twitch_user_id AS twitchUserId
       FROM bsky_sessions ORDER BY did`,
    ).all<{ did: string; twitchUserId: string | null }>();
    expect(rows.results).toEqual([
      { did: "did:plc:legacy", twitchUserId: "" },
      { did: "did:plc:new-1", twitchUserId: null },
      { did: "did:plc:new-2", twitchUserId: null },
    ]);
  });
});

describe("Bluesky 接続状態", () => {
  it("旧セッションの紐付けを再認証待ちとして保持し、再連携で有効化できる", async () => {
    const env0 = makeEnv();
    await env0.DB.prepare(
      `INSERT INTO users (
         twitch_user_id, twitch_username, twitch_display_name
       ) VALUES ('user-1', 'test_user', 'テストユーザー')`,
    ).run();
    await env0.DB.prepare(
      `INSERT INTO bsky_connections
         (twitch_user_id, did, status, reason)
       VALUES ('user-1', 'did:plc:test', 'reauth_required', 'legacy client')`,
    ).run();

    await expect(getBskyDidForUser(env0, "user-1")).resolves.toBeNull();
    await expect(getBskyConnectionForUser(env0, "user-1")).resolves.toMatchObject({
      did: "did:plc:test",
      status: "reauth_required",
      reason: "legacy client",
    });

    const dpopKey = await WebcryptoKey.generate(
      ["ES256"],
      crypto.randomUUID(),
      { extractable: true },
    );
    await createD1SessionStore(env0).set("did:plc:test", {
      dpopKey,
      authMethod: { method: "private_key_jwt", kid: "client-key" },
      tokenSet: {
        access_token: "access",
        refresh_token: "refresh",
        token_type: "DPoP",
        scope: "atproto",
        sub: "did:plc:test",
        iss: "https://bsky.social",
        aud: "https://pds.example.com",
        expires_at: Date.now() + 60_000,
      },
    } as never);
    await bindBskySessionToUser(env0, "user-1", "did:plc:test");

    await expect(getBskyDidForUser(env0, "user-1")).resolves.toBe(
      "did:plc:test",
    );
    await expect(getBskyConnectionForUser(env0, "user-1")).resolves.toMatchObject({
      did: "did:plc:test",
      status: "active",
      reason: null,
    });
  });
});

describe("D1 OAuth request lock", () => {
  it("同じ DID の処理を別実行間でも直列化する", async () => {
    const lock = createD1RequestLock(makeEnv(), {
      ttlMs: 5_000,
      waitTimeoutMs: 2_000,
      retryMs: 2,
    });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = lock("@atproto-oauth-client-did:plc:test", async () => {
      order.push("first:start");
      firstEntered();
      await firstGate;
      order.push("first:end");
    });
    await entered;

    const second = lock("@atproto-oauth-client-did:plc:test", async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("期限切れリースを引き継げる", async () => {
    const env0 = makeEnv();
    await env0.DB.prepare(
      `INSERT INTO bsky_oauth_locks (lock_name, owner_id, expires_at_ms)
       VALUES ('expired', 'dead-worker', 1)`,
    ).run();
    const lock = createD1RequestLock(env0, {
      ttlMs: 5_000,
      waitTimeoutMs: 100,
      retryMs: 1,
      now: () => 10_000,
      wait: async () => undefined,
    });

    await expect(lock("expired", async () => "ok")).resolves.toBe("ok");
    const row = await env0.DB.prepare(
      "SELECT owner_id FROM bsky_oauth_locks WHERE lock_name = 'expired'",
    ).first();
    expect(row).toBeNull();
  });
});
