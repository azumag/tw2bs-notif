import {
  OAuthClient,
  type Fetch,
  type HandleResolver,
  type OAuthClientMetadataInput,
  type RuntimeImplementation,
  type SessionStore,
  type StateStore,
} from "@atproto/oauth-client";
import type {
  AtprotoIdentityDidMethods,
  DidResolver,
  ResolvedDocument,
  ResolveDidOptions,
} from "@atproto-labs/did-resolver";
import type { ResolvedHandle } from "@atproto-labs/handle-resolver";
import {
  DidError,
  didDocumentValidator,
  didWebToUrl,
  isDidPlc,
  isDidWeb,
  type Did,
} from "@atproto/did";
import { WebcryptoKey } from "@atproto/jwk-webcrypto";
import { SimpleStoreMemory } from "@atproto-labs/simple-store-memory";
import type { Key } from "@atproto/jwk";
import type { AppEnv } from "../types";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * Bluesky OAuth(ユーザー別)クライアント。
 * 細粒度スコープ(PoC 確認済み)で、status と feed.post のみの権限を発行する。
 * セッションは D1(暗号化)に永続化し、DPoP 鍵は JWK として保存・復元する。
 */

export const BSKY_SCOPES =
  "atproto repo:app.bsky.actor.status repo:app.bsky.feed.post";

const CLIENT_ID = "https://orbsky.bluemoon.works/oauth-client-metadata.json";
const REDIRECT_URI = "https://orbsky.bluemoon.works/auth/bluesky/callback";
const OAUTH_STATE_PREFIX = "bsky_oauth_state:";
const OAUTH_STATE_TTL = 10 * 60;
const PLC_DIRECTORY_ORIGIN = "https://plc.directory";
const PLC_RETRY_DELAYS_MS = [100, 250] as const;

export const BSKY_CLIENT_METADATA: OAuthClientMetadataInput = {
  client_id: CLIENT_ID,
  application_type: "web",
  client_name: "orbsky",
  client_uri: "https://orbsky.bluemoon.works",
  policy_uri: "https://orbsky.bluemoon.works/privacy",
  redirect_uris: [REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: BSKY_SCOPES,
  token_endpoint_auth_method: "none",
  dpop_bound_access_tokens: true,
};

/**
 * ハンドル解決: HTTP Well-Known 方式のみ(Worker から DNS TXT は不可)。
 * https://<handle>/.well-known/atproto-did から DID を取得する。
 */
function createHandleResolver(): HandleResolver {
  return {
    async resolve(handle, options) {
      try {
        const url = `https://${handle}/.well-known/atproto-did`;
        const res = await fetch(url, {
          signal: options?.signal,
          redirect: "follow",
        });
        if (!res.ok) return null;
        const did = (await res.text()).trim();
        return (did.startsWith("did:") ? did : null) as ResolvedHandle;
      } catch {
        return null;
      }
    },
  };
}

type RetryWait = (ms: number, signal: AbortSignal) => Promise<void>;

function normalizeRedirectModeForWorkers(
  input: string | URL | Request,
  init?: RequestInit,
): RequestInit | undefined {
  const redirect =
    init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
  if (redirect !== "error") return init;

  // Workers は redirect="error" を受け付けない。manual もリダイレクトを
  // 追従せず、SDK 側が非 2xx を拒否するため安全性と結果は維持される。
  return { ...(init ?? {}), redirect: "manual" };
}

function isPlcDidRequest(
  input: string | URL | Request,
  init?: RequestInit,
): boolean {
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  if (method !== "GET") return false;
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== PLC_DIRECTORY_ORIGIN) return false;
  try {
    return decodeURIComponent(url.pathname).startsWith("/did:plc:");
  } catch {
    return false;
  }
}

function isRetryablePlcResponse(response: Response): boolean {
  return (
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500
  );
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      reject(signal.reason);
    };
    timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * OAuth SDK の全通信に使う fetch。
 * 本人確認に必須な PLC DID 文書の取得だけ、一時的なネットワーク失敗・
 * 408/429/5xx を短時間で再試行する。POST や他ホストは重複送信しない。
 */
export function createOAuthFetch(
  baseFetch: Fetch = fetch,
  wait: RetryWait = waitForRetry,
): Fetch {
  return async (input, init) => {
    const workersInit = normalizeRedirectModeForWorkers(input, init);

    // 判定時は body に触れない。Request を再構築すると元の body が使用済みになり、
    // clone でも init.body による正規の上書きを妨げるため。
    if (!isPlcDidRequest(input, workersInit)) {
      return baseFetch.call(globalThis, input, workersInit);
    }

    // 再試行対象は body を持たない PLC GET に限定されている。
    const request = new Request(input, workersInit);
    for (let attempt = 0; ; attempt += 1) {
      request.signal.throwIfAborted();
      try {
        const response = await baseFetch.call(globalThis, request.clone());
        if (
          !isRetryablePlcResponse(response) ||
          attempt === PLC_RETRY_DELAYS_MS.length
        ) {
          return response;
        }
        await response.body?.cancel().catch(() => undefined);
      } catch (err) {
        if (
          request.signal.aborted ||
          attempt === PLC_RETRY_DELAYS_MS.length
        ) {
          throw err;
        }
      }
      await wait(PLC_RETRY_DELAYS_MS[attempt], request.signal);
    }
  };
}

function getDidDocumentUrl(did: Did): URL {
  if (isDidPlc(did)) {
    return new URL(`/${encodeURIComponent(did)}`, PLC_DIRECTORY_ORIGIN);
  }
  if (isDidWeb(did)) {
    const base = didWebToUrl(did);
    if (base.protocol !== "https:") {
      throw new DidError(
        did,
        'Resolution of "http" did:web is not allowed',
        "did-web-http-not-allowed",
      );
    }
    return base.pathname === "/"
      ? new URL("/.well-known/did.json", base)
      : new URL(`${base.pathname}/did.json`, base);
  }
  throw new DidError(did, "Unsupported DID method", "did-method-invalid");
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Workers 互換の DID resolver。
 * 上流 resolver は fetch ラッパーより先に redirect="error" の Request を生成するため、
 * no-follow を保つ redirect="manual" で直接取得して同じ検証を行う。
 */
export function createWorkersDidResolver(
  oauthFetch: Fetch = createOAuthFetch(),
): DidResolver<AtprotoIdentityDidMethods> {
  return {
    async resolve<D extends Did>(
      did: D,
      options?: ResolveDidOptions,
    ): Promise<ResolvedDocument<D, AtprotoIdentityDidMethods>> {
      options?.signal?.throwIfAborted();
      const url = getDidDocumentUrl(did);
      let response: Response;
      try {
        response = await oauthFetch(url, {
          redirect: "manual",
          headers: {
            accept: "application/did+ld+json,application/json",
          },
          signal: options?.signal,
        });
      } catch (cause) {
        throw new DidError(
          did,
          cause instanceof Error ? cause.message : "Failed to fetch DID document",
          "did-fetch-error",
          400,
          cause,
        );
      }

      if (!response.ok) {
        await cancelResponseBody(response);
        throw new DidError(
          did,
          `Unexpected status code ${response.status} for "${url}"`,
          "did-fetch-error",
          response.status >= 500 ? 502 : response.status,
        );
      }

      const mime = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (mime !== "application/json" && mime !== "application/did+ld+json") {
        await cancelResponseBody(response);
        throw new DidError(
          did,
          `Unexpected content type for "${url}"`,
          "did-fetch-error",
          502,
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (cause) {
        throw new DidError(
          did,
          "Unable to parse response as JSON",
          "did-fetch-error",
          502,
          cause,
        );
      }

      let document;
      try {
        document = didDocumentValidator.parse(json);
      } catch (cause) {
        throw new DidError(
          did,
          "Invalid DID document",
          "did-document-format-error",
          503,
          cause,
        );
      }
      if (document.id !== did) {
        throw new DidError(
          did,
          `DID document id (${document.id}) does not match DID`,
          "did-document-id-mismatch",
        );
      }
      return document as ResolvedDocument<D, AtprotoIdentityDidMethods>;
    },
  };
}

// WebCrypto はアルゴリズム名が「SHA-256」形式必須(SDK は「sha256」で渡す)
const DIGEST_NAMES: Record<string, string> = {
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

const runtimeImplementation: RuntimeImplementation = {
  // extractable: true が必須(privateJwk で JWK 化して永続化するため)
  createKey: (algs: string[]) =>
    WebcryptoKey.generate(algs, crypto.randomUUID(), { extractable: true }),
  getRandomValues: (length: number) => {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  },
  digest: async (bytes: Uint8Array, algorithm: { name: string }) =>
    new Uint8Array(
      await crypto.subtle.digest(
        DIGEST_NAMES[algorithm.name] ?? algorithm.name,
        bytes,
      ),
    ),
};

/**
 * ストアの値を JWK 化して永続化するラッパー(NodeOAuthClient の toDpopKeyStore と同等)。
 * dpopKey(Key インスタンス) ↔ dpopJwk(JSON) を変換する。
 */
function toJwkStore<Data extends { dpopKey: Key }>(
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    del: (key: string) => Promise<void>;
  },
) {
  return {
    async set(key: string, value: Data) {
      const { dpopKey, ...data } = value;
      const dpopJwk = dpopKey.privateJwk;
      if (!dpopJwk) throw new Error("Private DPoP JWK is missing.");
      await store.set(key, { ...data, dpopJwk });
    },
    async get(key: string) {
      const result = (await store.get(key)) as
        | ({ dpopJwk?: object } & Partial<Data>)
        | undefined;
      if (!result) return undefined;
      const { dpopJwk, ...data } = result;
      if (!dpopJwk) return undefined;
      const dpopKey = await WebcryptoKey.fromJWK(dpopJwk as never);
      return { ...data, dpopKey } as unknown as Data;
    },
    del: (key: string) => store.del(key),
  };
}

/** OAuth 認可フロー中の state を KV に保存する(10分TTL) */
export function createKvStateStore(env: AppEnv): StateStore {
  return toJwkStore({
    async get(key) {
      const raw = await env.STATE.get(`${OAUTH_STATE_PREFIX}${key}`, "json");
      return raw ?? undefined;
    },
    async set(key, value) {
      await env.STATE.put(`${OAUTH_STATE_PREFIX}${key}`, JSON.stringify(value), {
        expirationTtl: OAUTH_STATE_TTL,
      });
    },
    async del(key) {
      await env.STATE.delete(`${OAUTH_STATE_PREFIX}${key}`);
    },
  }) as unknown as StateStore;
}

/** Bluesky セッションを D1 に暗号化して永続化する */
export function createD1SessionStore(env: AppEnv): SessionStore {
  return toJwkStore({
    async get(did) {
      const row = await env.DB.prepare(
        "SELECT session_json_enc AS enc FROM bsky_sessions WHERE did = ?",
      )
        .bind(did)
        .first<{ enc: string }>();
      if (!row) return undefined;
      return JSON.parse(await decryptSecret(env, row.enc));
    },
    async set(did, value) {
      const enc = await encryptSecret(env, JSON.stringify(value));
      await env.DB.prepare(
        `INSERT INTO bsky_sessions (did, twitch_user_id, session_json_enc)
         VALUES (?, '', ?)
         ON CONFLICT (did) DO UPDATE SET
           session_json_enc = excluded.session_json_enc,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
        .bind(did, enc)
        .run();
    },
    async del(did) {
      await env.DB.prepare("DELETE FROM bsky_sessions WHERE did = ?")
        .bind(did)
        .run();
    },
  }) as unknown as SessionStore;
}

let client: OAuthClient | undefined;

export function getOAuthClient(env: AppEnv): OAuthClient {
  if (client) return client;
  const oauthFetch = createOAuthFetch();
  client = new OAuthClient({
    responseMode: "query",
    clientMetadata: BSKY_CLIENT_METADATA,
    handleResolver: createHandleResolver(),
    didResolver: createWorkersDidResolver(oauthFetch),
    fetch: oauthFetch,
    runtimeImplementation,
    stateStore: createKvStateStore(env),
    sessionStore: createD1SessionStore(env),
    // 一時キャッシュ(isolate 内のみ。失効してもリトライで回復する)
    authorizationServerMetadataCache: new SimpleStoreMemory({ max: 100 }),
    protectedResourceMetadataCache: new SimpleStoreMemory({ max: 100 }),
    dpopNonceCache: new SimpleStoreMemory({ max: 100, ttl: 60e3 }),
  });
  return client;
}

/**
 * Bluesky 認可 URL を生成する。
 * PDS URL 起点で開始するため、Bluesky 側の認可画面でログイン/アカウント選択ができる
 * (ハンドル入力を省略し、prompt=select_account で既存セッションのアカウント選択を促す)。
 * 他の PDS ユーザーへの対応は将来(入力欄で PDS URL を受け付ける等)。
 */
export async function createBskyAuthorizeUrl(
  env: AppEnv,
): Promise<URL> {
  return getOAuthClient(env).authorize("https://bsky.social", {
    scope: BSKY_SCOPES,
    prompt: "select_account",
  });
}

/** コールバックを完了し、セッションを永続化する。DID を返す */
export async function completeBskyAuthorization(
  env: AppEnv,
  params: URLSearchParams,
): Promise<{ did: string }> {
  const { session } = await getOAuthClient(env).callback(params);
  return { did: session.did };
}

/** Twitch ユーザーに Bluesky DID を紐付ける */
export async function bindBskySessionToUser(
  env: AppEnv,
  userId: string,
  did: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE bsky_sessions SET twitch_user_id = ?
     WHERE did = ?`,
  )
    .bind(userId, did)
    .run();
}

/** ユーザーが Bluesky 連携済みか */
export async function getBskyDidForUser(
  env: AppEnv,
  userId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT did FROM bsky_sessions WHERE twitch_user_id = ?",
  )
    .bind(userId)
    .first<{ did: string }>();
  return row?.did ?? null;
}

/** Bluesky 連携を解除する(セッション削除 + リボーク) */
export async function disconnectBsky(
  env: AppEnv,
  userId: string,
): Promise<void> {
  const did = await getBskyDidForUser(env, userId);
  if (!did) return;
  try {
    await getOAuthClient(env).revoke(did);
  } catch {
    // リボーク失敗は無視(ローカル削除は行う)
  }
  await env.DB.prepare("DELETE FROM bsky_sessions WHERE did = ?").bind(did).run();
}
