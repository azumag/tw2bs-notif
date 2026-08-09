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
  createOAuthFetch,
  createWorkersDidResolver,
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
  await env0.DB.prepare(
    `INSERT OR IGNORE INTO users (
       twitch_user_id, twitch_username, twitch_display_name
     ) VALUES ('user-1', 'test_user', 'テストユーザー')`,
  ).run();
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
    expect(body.policy_uri).toBe("https://orbsky.bluemoon.works/privacy");
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

describe("PLC DID 解決 fetch", () => {
  it.each([408, 429, 503])(
    "PLC の一時的な HTTP %i を再試行する",
    async (status) => {
      const baseFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("temporary", { status }))
        .mockResolvedValueOnce(
          Response.json({ id: "did:plc:test" }, { status: 200 }),
        );
      const waits: number[] = [];
      const oauthFetch = createOAuthFetch(baseFetch, async (ms) => {
        waits.push(ms);
      });

      const response = await oauthFetch(
        "https://plc.directory/did%3Aplc%3Atest",
      );

      expect(response.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(2);
      expect(waits).toEqual([100]);
    },
  );

  it("PLC のネットワークエラーを最大3回まで再試行する", async () => {
    const baseFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("down"));
    const waits: number[] = [];
    const oauthFetch = createOAuthFetch(baseFetch, async (ms) => {
      waits.push(ms);
    });

    await expect(
      oauthFetch("https://plc.directory/did:plc:test"),
    ).rejects.toThrow("down");
    expect(baseFetch).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([100, 250]);
  });

  it("Workers 非対応の redirect=error を PLC GET で manual に変換する", async () => {
    const redirects: string[] = [];
    const baseFetch = vi.fn<typeof fetch>(async (input, init) => {
      redirects.push(new Request(input, init).redirect);
      return Response.json({ id: "did:plc:test" }, { status: 200 });
    });
    const oauthFetch = createOAuthFetch(baseFetch);
    const init = { redirect: "error" as const };

    const response = await oauthFetch(
      "https://plc.directory/did:plc:test",
      init,
    );

    expect(response.status).toBe(200);
    expect(redirects).toEqual(["manual"]);
    expect(init.redirect).toBe("error");
  });

  it("PLC 以外の resolver GET でも redirect=error を manual に変換する", async () => {
    const baseFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return Response.json({ id: "did:web:example.com" }, { status: 200 });
    });
    const wait = vi.fn(async () => undefined);
    const oauthFetch = createOAuthFetch(baseFetch, wait);

    const response = await oauthFetch(
      "https://example.com/.well-known/did.json",
      { redirect: "error" },
    );

    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "PLC DID への POST",
      input: "https://plc.directory/did:plc:test",
      init: { method: "POST" },
    },
    {
      label: "PLC の DID 以外のパス",
      input: "https://plc.directory/other",
      init: undefined,
    },
    {
      label: "PLC 以外のホスト",
      input: "https://example.com/did:plc:test",
      init: undefined,
    },
  ])("$label は 503 でも再試行しない", async ({ input, init }) => {
    const baseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("temporary", { status: 503 }));
    const wait = vi.fn(async () => undefined);
    const oauthFetch = createOAuthFetch(baseFetch, wait);

    const response = await oauthFetch(input, init);

    expect(response.status).toBe(503);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("OAuth の body 付き Request を使用済みにせず1回だけ送信する", async () => {
    const baseFetch = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const form = await request.formData();
      expect(form.get("grant_type")).toBe("authorization_code");
      return new Response("ok", { status: 200 });
    });
    const wait = vi.fn(async () => undefined);
    const oauthFetch = createOAuthFetch(baseFetch, wait);
    const request = new Request("https://bsky.social/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });

    const response = await oauthFetch(request);

    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("使用済み Request でも init.body の上書きを妨げない", async () => {
    const baseFetch = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const form = await request.formData();
      expect(form.get("grant_type")).toBe("refresh_token");
      return new Response("ok", { status: 200 });
    });
    const wait = vi.fn(async () => undefined);
    const oauthFetch = createOAuthFetch(baseFetch, wait);
    const usedRequest = new Request("https://bsky.social/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });
    await usedRequest.formData();

    const response = await oauthFetch(usedRequest, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token",
    });

    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("開始前に abort 済みなら PLC へ送信しない", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    const baseFetch = vi.fn<typeof fetch>();
    const oauthFetch = createOAuthFetch(baseFetch);

    await expect(
      oauthFetch(
        new Request("https://plc.directory/did:plc:test", {
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("再試行待機中に abort されたら次の fetch を送信しない", async () => {
    const controller = new AbortController();
    const baseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const oauthFetch = createOAuthFetch(baseFetch);
    setTimeout(
      () => controller.abort(new DOMException("stopped", "AbortError")),
      10,
    );

    await expect(
      oauthFetch(
        new Request("https://plc.directory/did:plc:test", {
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});

describe("Workers DID resolver", () => {
  const did = "did:plc:dekk6rd3sp52ocea6qmalxm2" as const;
  const document = {
    id: did,
    alsoKnownAs: ["at://azumag.bsky.social"],
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: "https://pds.example.com",
      },
    ],
  };

  it("上流の Request 生成を介さず manual で PLC DID 文書を取得する", async () => {
    const requests: Array<{ url: string; redirect: string }> = [];
    const baseFetch = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, redirect: request.redirect });
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: { "Content-Type": "application/did+ld+json; charset=utf-8" },
      });
    });
    const resolver = createWorkersDidResolver(createOAuthFetch(baseFetch));

    const resolved = await resolver.resolve(did);

    expect(resolved.id).toBe(did);
    expect(requests).toEqual([
      {
        url: `https://plc.directory/${encodeURIComponent(did)}`,
        redirect: "manual",
      },
    ]);
  });

  it("PLC のリダイレクト応答を追従も再試行もしない", async () => {
    const baseFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Request(input, init).redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://example.com/redirected" },
      });
    });
    const wait = vi.fn(async () => undefined);
    const resolver = createWorkersDidResolver(createOAuthFetch(baseFetch, wait));

    await expect(resolver.resolve(did)).rejects.toMatchObject({
      code: "did-fetch-error",
      status: 302,
    });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("要求した DID と異なる文書を拒否する", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { ...document, id: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" },
        { status: 200 },
      ),
    );
    const resolver = createWorkersDidResolver(createOAuthFetch(baseFetch));

    await expect(resolver.resolve(did)).rejects.toMatchObject({
      code: "did-document-id-mismatch",
    });
  });

  it("ネットワーク失敗を did-fetch-error に変換する", async () => {
    const cause = new TypeError("network failed");
    const baseFetch = vi.fn<typeof fetch>().mockRejectedValue(cause);
    const resolver = createWorkersDidResolver(
      createOAuthFetch(baseFetch, async () => undefined),
    );

    await expect(resolver.resolve(did)).rejects.toMatchObject({
      code: "did-fetch-error",
      status: 400,
      cause,
    });
    expect(baseFetch).toHaveBeenCalledTimes(3);
  });

  it("不正JSONを did-fetch-error として拒否する", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const resolver = createWorkersDidResolver(createOAuthFetch(baseFetch));

    await expect(resolver.resolve(did)).rejects.toMatchObject({
      code: "did-fetch-error",
      status: 502,
      cause: expect.any(Error),
    });
  });

  it("スキーマ不正を did-document-format-error として拒否する", async () => {
    const baseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: did, service: "invalid" }));
    const resolver = createWorkersDidResolver(createOAuthFetch(baseFetch));

    await expect(resolver.resolve(did)).rejects.toMatchObject({
      code: "did-document-format-error",
      status: 503,
      cause: expect.any(Error),
    });
  });

  it("ATProtoで有効なroot did:webを manual で取得する", async () => {
    const webDid = "did:web:example.com" as const;
    const baseFetch = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://example.com/.well-known/did.json");
      expect(request.redirect).toBe("manual");
      return Response.json({ id: webDid }, { status: 200 });
    });
    const resolver = createWorkersDidResolver(createOAuthFetch(baseFetch));

    await expect(resolver.resolve(webDid)).resolves.toMatchObject({ id: webDid });
  });

  it("HTTPになるlocalhostのdid:webを取得前に拒否する", async () => {
    const baseFetch = vi.fn<typeof fetch>();
    const resolver = createWorkersDidResolver(createOAuthFetch(baseFetch));

    await expect(resolver.resolve("did:web:localhost")).rejects.toMatchObject({
      code: "did-web-http-not-allowed",
    });
    expect(baseFetch).not.toHaveBeenCalled();
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

  it("未連携の設定ページは連携ボタンを表示する(ハンドル入力なし)", async () => {
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
    expect(body).not.toContain("name=\"handle\"");
    expect(body).toContain("配信開始時の自動ポスト");
    expect(body).toContain('href="/channels"');
    expect(body).toContain("投稿設定を開く");
    expect(body).toContain("すべてのプランで利用できます");
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

  it("Bluesky連携ボタンで認可URLへリダイレクトする", async () => {
    const bskyOauth = await import("../src/lib/bsky-oauth");
    const env0 = makeEnv();
    const { cookie } = await loginAndGetCookie(env0);

    const mockAuthorize = vi
      .spyOn(bskyOauth, "createBskyAuthorizeUrl")
      .mockResolvedValue(
        new URL("https://bsky.social/oauth/authorize?client_id=test"),
      );

    const res = await fetchAs(
      env0,
      new Request("https://example.com/auth/bluesky/login", {
        headers: { Cookie: cookie },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain(
      "https://bsky.social/oauth/authorize",
    );
    expect(mockAuthorize).toHaveBeenCalled();
    mockAuthorize.mockRestore();
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
