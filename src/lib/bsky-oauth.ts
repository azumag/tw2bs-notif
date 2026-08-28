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
import { logError, logInfo } from "./logger";

/**
 * Bluesky OAuth(ユーザー別)クライアント。
 * 細粒度スコープ(PoC 確認済み)で、status と feed.post の書き込み権限を発行する。
 * blob:image/* は embed.external の thumb(配信サムネイル)を uploadBlob するために
 * 必要(blob パーミッションは permission set に含められず、直接リクエストが必須)。
 *
 * confidential client の ES256 署名鍵とユーザーセッションは、既存の
 * ENCRYPTION_KEY で暗号化して D1 に永続化する。トークン更新は D1 の
 * リースロックで DID ごとに直列化し、refresh token の二重使用を防ぐ。
 */

export const BSKY_SCOPES =
  "atproto repo:app.bsky.actor.status repo:app.bsky.feed.post blob:image/*";

const CLIENT_ORIGIN = "https://orbsky.bluemoon.works";
const CLIENT_ID = `${CLIENT_ORIGIN}/oauth-client-metadata.json`;
const REDIRECT_URI = `${CLIENT_ORIGIN}/auth/bluesky/callback`;
export const BSKY_JWKS_PATH = "/oauth-jwks.json";
const JWKS_URI = `${CLIENT_ORIGIN}${BSKY_JWKS_PATH}`;
const OAUTH_STATE_PREFIX = "bsky_oauth_state:";
const OAUTH_STATE_TTL = 10 * 60;
const PLC_DIRECTORY_ORIGIN = "https://plc.directory";
const PLC_RETRY_DELAYS_MS = [100, 250] as const;
const CLIENT_KEY_NAME = "primary";
const OAUTH_LOCK_TTL_MS = 45_000;
const OAUTH_LOCK_WAIT_TIMEOUT_MS = 60_000;
const OAUTH_LOCK_RETRY_MS = 25;
const MAX_EVENT_REASON_LENGTH = 1_000;

export const BSKY_CLIENT_METADATA: OAuthClientMetadataInput = {
  client_id: CLIENT_ID,
  application_type: "web",
  client_name: "orbsky",
  client_uri: CLIENT_ORIGIN,
  policy_uri: `${CLIENT_ORIGIN}/privacy`,
  redirect_uris: [REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: BSKY_SCOPES,
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_signing_alg: "ES256",
  jwks_uri: JWKS_URI,
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

type LockWait = (ms: number) => Promise<void>;

export interface D1RequestLockOptions {
  ttlMs?: number;
  waitTimeoutMs?: number;
  retryMs?: number;
  now?: () => number;
  wait?: LockWait;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OAuth SDK の requestLock 実装。
 * refresh token はローテーションされ一度しか使えないため、同一 DID の
 * restore/refresh を全 Worker isolate 間で直列化する。Worker が途中終了しても
 * expires_at_ms 後に別の実行がリースを引き継げる。
 */
export function createD1RequestLock(
  env: AppEnv,
  options: D1RequestLockOptions = {},
): NonNullable<RuntimeImplementation["requestLock"]> {
  const ttlMs = options.ttlMs ?? OAUTH_LOCK_TTL_MS;
  const waitTimeoutMs =
    options.waitTimeoutMs ?? OAUTH_LOCK_WAIT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? OAUTH_LOCK_RETRY_MS;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitMs;

  const requestLock: NonNullable<RuntimeImplementation["requestLock"]> = async (
    name,
    fn,
  ) => {
    const ownerId = crypto.randomUUID();
    const startedAt = now();

    for (;;) {
      const current = now();
      const acquired = await env.DB.prepare(
        `INSERT INTO bsky_oauth_locks (lock_name, owner_id, expires_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (lock_name) DO UPDATE SET
           owner_id = excluded.owner_id,
           expires_at_ms = excluded.expires_at_ms
         WHERE bsky_oauth_locks.expires_at_ms <= ?`,
      )
        .bind(name, ownerId, current + ttlMs, current)
        .run();

      if (acquired.meta.changes > 0) break;
      if (current - startedAt >= waitTimeoutMs) {
        throw new Error(`Timed out acquiring Bluesky OAuth lock: ${name}`);
      }
      await wait(retryMs + Math.floor(Math.random() * retryMs));
    }

    try {
      return await fn();
    } finally {
      try {
        await env.DB.prepare(
          `DELETE FROM bsky_oauth_locks
           WHERE lock_name = ? AND owner_id = ?`,
        )
          .bind(name, ownerId)
          .run();
      } catch (err) {
        // リース期限で必ず回復するため、解放失敗で本来の OAuth 結果を潰さない。
        logError("bsky", "oauth lock release failed", err, { name });
      }
    }
  };

  return requestLock;
}

function createRuntimeImplementation(env: AppEnv): RuntimeImplementation {
  return {
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
    requestLock: createD1RequestLock(env),
  };
}

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
        `INSERT INTO bsky_sessions (did, session_json_enc)
         VALUES (?, ?)
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

interface ClientKeyRow {
  enc: string;
}

async function importClientSigningKey(serializedJwk: string): Promise<Key> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedJwk);
  } catch (cause) {
    throw new Error("Stored Bluesky OAuth client JWK is invalid JSON", {
      cause,
    });
  }
  const key = await WebcryptoKey.fromJWK(parsed as never);
  if (!key.privateJwk) {
    throw new Error("Stored Bluesky OAuth client JWK is not private");
  }
  if (!key.kid) {
    throw new Error("Stored Bluesky OAuth client JWK has no kid");
  }
  if (key.alg !== "ES256") {
    throw new Error("Stored Bluesky OAuth client JWK must use ES256");
  }
  if (!key.publicJwk) {
    throw new Error("Stored Bluesky OAuth client JWK has no public key");
  }
  return key;
}

/**
 * confidential client の署名鍵を取得する。未作成なら ES256 鍵を生成し、
 * 秘密 JWK を暗号化して D1 に一度だけ保存する。並行初期化時は INSERT OR IGNORE
 * で勝者を一つに絞り、全 isolate が同じ保存済み鍵を読み直す。
 */
async function getOrCreateClientSigningKey(env: AppEnv): Promise<Key> {
  const existing = await env.DB.prepare(
    `SELECT private_jwk_enc AS enc
     FROM bsky_oauth_client_keys WHERE key_name = ?`,
  )
    .bind(CLIENT_KEY_NAME)
    .first<ClientKeyRow>();
  if (existing) {
    return importClientSigningKey(await decryptSecret(env, existing.enc));
  }

  const generated = await WebcryptoKey.generate(
    ["ES256"],
    crypto.randomUUID(),
    { extractable: true },
  );
  const privateJwk = generated.privateJwk;
  if (!privateJwk || !generated.publicJwk) {
    throw new Error("Failed to generate Bluesky OAuth client signing key");
  }
  const enc = await encryptSecret(env, JSON.stringify(privateJwk));
  await env.DB.prepare(
    `INSERT OR IGNORE INTO bsky_oauth_client_keys
       (key_name, private_jwk_enc)
     VALUES (?, ?)`,
  )
    .bind(CLIENT_KEY_NAME, enc)
    .run();

  const stored = await env.DB.prepare(
    `SELECT private_jwk_enc AS enc
     FROM bsky_oauth_client_keys WHERE key_name = ?`,
  )
    .bind(CLIENT_KEY_NAME)
    .first<ClientKeyRow>();
  if (!stored) {
    throw new Error("Failed to persist Bluesky OAuth client signing key");
  }
  return importClientSigningKey(await decryptSecret(env, stored.enc));
}

/** 認可サーバーへ公開する client authentication 用 JWKS。秘密値は含めない。 */
export async function getBskyPublicJwks(env: AppEnv) {
  const key = await getOrCreateClientSigningKey(env);
  const publicJwk = key.publicJwk;
  if (!publicJwk) {
    throw new Error("Bluesky OAuth client public JWK is missing");
  }
  return { keys: [publicJwk] };
}

function summarizeCause(cause: unknown): string | null {
  if (cause == null) return null;
  const summary =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : String(cause);
  return summary.slice(0, MAX_EVENT_REASON_LENGTH);
}

function sessionDeletionEventType(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : "";
  if (name.includes("Revoked")) return "revoked";
  if (name.includes("Refresh") || name.includes("Invalid")) {
    return "reauth_required";
  }
  return "deleted";
}

async function recordSessionDeletion(
  env: AppEnv,
  did: string,
  cause: unknown,
): Promise<void> {
  const eventType = sessionDeletionEventType(cause);
  const reason = summarizeCause(cause);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO bsky_oauth_events (did, event_type, reason)
         VALUES (?, ?, ?)`,
      ).bind(did, eventType, reason),
      env.DB.prepare(
        `UPDATE bsky_connections
         SET status = 'reauth_required',
             reason = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE did = ?`,
      ).bind(reason ?? "Blueskyの再認証が必要です。", did),
    ]);
  } catch (err) {
    logError("bsky", "oauth session deletion audit failed", err, { did });
  }

  if (eventType === "revoked") {
    logInfo("bsky", "oauth session revoked", { did, reason });
  } else {
    logError("bsky", "oauth session deleted", cause, { did, eventType });
  }
}

let clientCache: { kid: string; client: OAuthClient } | undefined;

export async function getOAuthClient(env: AppEnv): Promise<OAuthClient> {
  const signingKey = await getOrCreateClientSigningKey(env);
  if (!signingKey.kid) {
    throw new Error("Bluesky OAuth client signing key has no kid");
  }
  if (clientCache?.kid === signingKey.kid) return clientCache.client;

  const oauthFetch = createOAuthFetch();
  const client = new OAuthClient({
    responseMode: "query",
    clientMetadata: BSKY_CLIENT_METADATA,
    keyset: [signingKey],
    handleResolver: createHandleResolver(),
    didResolver: createWorkersDidResolver(oauthFetch),
    fetch: oauthFetch,
    runtimeImplementation: createRuntimeImplementation(env),
    stateStore: createKvStateStore(env),
    sessionStore: createD1SessionStore(env),
    onSessionDeleted: async (did, cause) => {
      await recordSessionDeletion(env, did, cause);
    },
    // 一時キャッシュ(isolate 内のみ。失効してもリトライで回復する)
    authorizationServerMetadataCache: new SimpleStoreMemory({ max: 100 }),
    protectedResourceMetadataCache: new SimpleStoreMemory({ max: 100 }),
    dpopNonceCache: new SimpleStoreMemory({ max: 100, ttl: 60e3 }),
  });
  clientCache = { kid: signingKey.kid, client };
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
  return (await getOAuthClient(env)).authorize("https://bsky.social", {
    scope: BSKY_SCOPES,
    prompt: "select_account",
  });
}

/** コールバックを完了し、セッションを永続化する。DID を返す */
export async function completeBskyAuthorization(
  env: AppEnv,
  params: URLSearchParams,
): Promise<{ did: string }> {
  const { session } = await (await getOAuthClient(env)).callback(params);
  return { did: session.did };
}

/** Twitch ユーザーに Bluesky DID を紐付ける */
export async function bindBskySessionToUser(
  env: AppEnv,
  userId: string,
  did: string,
): Promise<void> {
  // 同じユーザーの旧DID、同じDIDに残った旧ユーザーの紐付けを外してから、
  // 現在の認可結果を唯一の有効な接続として保存する。
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM bsky_connections
       WHERE twitch_user_id = ? OR did = ?`,
    ).bind(userId, did),
    env.DB.prepare(
      `INSERT INTO bsky_connections
         (twitch_user_id, did, status, reason, updated_at)
       VALUES (?, ?, 'active', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).bind(userId, did),
  ]);
}

export type BskyConnectionStatus = "active" | "reauth_required";

export interface BskyConnection {
  did: string;
  status: BskyConnectionStatus;
  reason: string | null;
}

/** UI・解除処理用に、再認証待ちを含む保存済みの紐付けを返す。 */
export async function getBskyConnectionForUser(
  env: AppEnv,
  userId: string,
): Promise<BskyConnection | null> {
  const row = await env.DB.prepare(
    `SELECT did, status, reason
     FROM bsky_connections WHERE twitch_user_id = ?`,
  )
    .bind(userId)
    .first<BskyConnection>();
  return row ?? null;
}

/** 自動処理に利用できる、有効な Bluesky DID を返す。 */
export async function getBskyDidForUser(
  env: AppEnv,
  userId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT c.did
     FROM bsky_connections c
     JOIN bsky_sessions s ON s.did = c.did
     WHERE c.twitch_user_id = ? AND c.status = 'active'`,
  )
    .bind(userId)
    .first<{ did: string }>();
  return row?.did ?? null;
}

/** Bluesky 連携を解除する(セッション削除 + リボーク + 紐付け削除) */
export async function disconnectBsky(
  env: AppEnv,
  userId: string,
): Promise<void> {
  const connection = await getBskyConnectionForUser(env, userId);
  if (!connection) return;
  try {
    await (await getOAuthClient(env)).revoke(connection.did);
  } catch {
    // リボーク失敗は無視(ローカル削除は行う)
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM bsky_connections WHERE twitch_user_id = ?",
    ).bind(userId),
    env.DB.prepare("DELETE FROM bsky_sessions WHERE did = ?").bind(
      connection.did,
    ),
  ]);
}
