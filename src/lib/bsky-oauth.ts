import {
  OAuthClient,
  TokenInvalidError,
  TokenRefreshError,
  TokenRevokedError,
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
 * 細粒度スコープで、status と feed.post の書き込み権限を発行する。
 * blob:image/* は embed.external の thumb(配信サムネイル)を uploadBlob するために
 * 必要(blob パーミッションは permission set に含められず、直接リクエストが必須)。
 *
 * OAuth クライアント自身は private_key_jwt で認証する confidential client とし、
 * クライアント秘密鍵・ユーザーセッション・DPoP 鍵を暗号化して D1 に永続化する。
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
const CLIENT_KEY_ALG = "ES256";
const LOCK_LEASE_MS = 90_000;
const LOCK_WAIT_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 25;

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
  jwks_uri: JWKS_URI,
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_signing_alg: CLIENT_KEY_ALG,
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

type RequestLockOptions = {
  leaseMs?: number;
  waitTimeoutMs?: number;
  retryMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
};

async function defaultLockWait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * D1 の条件付き UPSERT を使う期限付き分散ロック。
 * ATProto の refresh token はローテーション式なので、Worker の別 isolate や
 * Queue 消費が同じ DID を同時 refresh しないよう、SDK の requestLock に渡す。
 */
export function createD1RequestLock(
  env: AppEnv,
  options: RequestLockOptions = {},
): NonNullable<RuntimeImplementation["requestLock"]> {
  const leaseMs = options.leaseMs ?? LOCK_LEASE_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultLockWait;

  const requestLock: NonNullable<RuntimeImplementation["requestLock"]> =
    async (name, fn) => {
      const ownerId = crypto.randomUUID();
      const deadline = now() + waitTimeoutMs;

      for (;;) {
        const current = now();
        const result = await env.DB.prepare(
          `INSERT INTO bsky_oauth_locks (lock_name, owner_id, expires_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT (lock_name) DO UPDATE SET
             owner_id = excluded.owner_id,
             expires_at_ms = excluded.expires_at_ms
           WHERE bsky_oauth_locks.expires_at_ms <= ?`,
        )
          .bind(name, ownerId, current + leaseMs, current)
          .run();

        if (Number(result.meta.changes) > 0) break;
        if (current >= deadline) {
          throw new Error(`Timed out waiting for Bluesky OAuth lock: ${name}`);
        }
        await wait(Math.min(retryMs, Math.max(1, deadline - current)));
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
          // リース切れで回復できるため、本処理の成功結果は壊さない。
          logError("bsky", "oauth lock release failed", err, { name });
        }
      }
    };

  return requestLock;
}

export function createRuntimeImplementation(
  env: AppEnv,
): RuntimeImplementation {
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

function assertClientSigningKey(key: Key): Key {
  if (!key.privateJwk) {
    throw new Error("Bluesky OAuth client key is not private.");
  }
  if (!key.publicJwk) {
    throw new Error("Bluesky OAuth client public JWK is unavailable.");
  }
  if (!key.kid) {
    throw new Error("Bluesky OAuth client key has no kid.");
  }
  if (!key.algorithms.includes(CLIENT_KEY_ALG)) {
    throw new Error(`Bluesky OAuth client key must support ${CLIENT_KEY_ALG}.`);
  }
  return key;
}

async function importClientSigningKey(serialized: string): Promise<Key> {
  let jwk: unknown;
  try {
    jwk = JSON.parse(serialized);
  } catch (cause) {
    throw new Error("Stored Bluesky OAuth client JWK is invalid JSON.", {
      cause,
    });
  }
  const key = await WebcryptoKey.fromJWK(jwk as never);
  return assertClientSigningKey(key);
}

async function getOrCreateClientSigningKey(env: AppEnv): Promise<Key> {
  const existing = await env.DB.prepare(
    `SELECT private_jwk_enc AS enc
     FROM bsky_oauth_client_keys
     WHERE key_name = ?`,
  )
    .bind(CLIENT_KEY_NAME)
    .first<ClientKeyRow>();
  if (existing) {
    return importClientSigningKey(await decryptSecret(env, existing.enc));
  }

  // 複数 isolate が同時に初回アクセスしても INSERT OR IGNORE で1本に収束する。
  const generated = assertClientSigningKey(
    await WebcryptoKey.generate(
      [CLIENT_KEY_ALG],
      crypto.randomUUID(),
      { extractable: true },
    ),
  );
  const privateJwk = generated.privateJwk;
  if (!privateJwk) throw new Error("Generated client key is not exportable.");
  const enc = await encryptSecret(env, JSON.stringify(privateJwk));
  await env.DB.prepare(
    `INSERT OR IGNORE INTO bsky_oauth_client_keys
       (key_name, private_jwk_enc)
     VALUES (?, ?)`,
  )
    .bind(CLIENT_KEY_NAME, enc)
    .run();

  const persisted = await env.DB.prepare(
    `SELECT private_jwk_enc AS enc
     FROM bsky_oauth_client_keys
     WHERE key_name = ?`,
  )
    .bind(CLIENT_KEY_NAME)
    .first<ClientKeyRow>();
  if (!persisted) {
    throw new Error("Failed to persist Bluesky OAuth client key.");
  }
  return importClientSigningKey(await decryptSecret(env, persisted.enc));
}

/** OAuth 認可サーバーへ公開する、秘密値を含まない JWKS。 */
export async function getBskyPublicJwks(
  env: AppEnv,
): Promise<{ keys: object[] }> {
  const key = await getOrCreateClientSigningKey(env);
  const publicJwk = key.publicJwk;
  if (!publicJwk) throw new Error("Bluesky OAuth public JWK is unavailable.");
  return { keys: [{ ...publicJwk }] };
}

function summarizeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const nested = cause.cause instanceof Error
      ? `; cause=${cause.cause.name}: ${cause.cause.message}`
      : "";
    return `${cause.name}: ${cause.message}${nested}`.slice(0, 1000);
  }
  return String(cause ?? "unknown").slice(0, 1000);
}

function sessionDeletionEventType(cause: unknown): string {
  if (cause instanceof TokenRefreshError) return "refresh_failed";
  if (cause instanceof TokenRevokedError) return "revoked";
  if (cause instanceof TokenInvalidError) return "invalid_token";
  return "deleted";
}

async function recordSessionDeletion(
  env: AppEnv,
  did: string,
  cause: unknown,
): Promise<void> {
  const reason = summarizeCause(cause);
  const eventType = sessionDeletionEventType(cause);
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
    ).bind(reason, did),
  ]);
  logInfo("bsky", "oauth session deleted", { did, eventType, reason });
}

let clientCache:
  | { db: D1Database; kid: string; client: OAuthClient }
  | undefined;

export async function getOAuthClient(env: AppEnv): Promise<OAuthClient> {
  const signingKey = await getOrCreateClientSigningKey(env);
  const kid = signingKey.kid;
  if (!kid) throw new Error("Bluesky OAuth client key has no kid.");
  if (clientCache?.db === env.DB && clientCache.kid === kid) {
    return clientCache.client;
  }

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
    // 一時キャッシュ(isolate 内のみ。失効してもリトライで回復する)
    authorizationServerMetadataCache: new SimpleStoreMemory({ max: 100 }),
    protectedResourceMetadataCache: new SimpleStoreMemory({ max: 100 }),
    dpopNonceCache: new SimpleStoreMemory({ max: 100, ttl: 60e3 }),
    onSessionDeleted: async (did, cause) => {
      try {
        await recordSessionDeletion(env, did, cause);
      } catch (err) {
        // 監査記録の障害で SDK 本体のセッション削除を失敗させない。
        logError("bsky", "failed to record oauth session deletion", err, {
          did,
          originalCause: summarizeCause(cause),
        });
      }
    },
  });
  clientCache = { db: env.DB, kid, client };
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

export type BskyConnectionStatus = "active" | "reauth_required";

export interface BskyConnection {
  twitchUserId: string;
  did: string;
  status: BskyConnectionStatus;
  reason: string | null;
}

/** Twitch ユーザーに紐付く Bluesky 連携状態を取得する。 */
export async function getBskyConnectionForUser(
  env: AppEnv,
  userId: string,
): Promise<BskyConnection | null> {
  const row = await env.DB.prepare(
    `SELECT
       twitch_user_id AS twitchUserId,
       did,
       status,
       reason
     FROM bsky_connections
     WHERE twitch_user_id = ?`,
  )
    .bind(userId)
    .first<BskyConnection>();
  return row ?? null;
}

/** Twitch ユーザーに Bluesky DID を紐付け、再認証状態を active に戻す。 */
export async function bindBskySessionToUser(
  env: AppEnv,
  userId: string,
  did: string,
): Promise<void> {
  await env.DB.batch([
    // 同じ Twitch ユーザーが別アカウントへ切り替えた場合の孤児セッションを除去する。
    env.DB.prepare(
      `DELETE FROM bsky_sessions
       WHERE did IN (
         SELECT did FROM bsky_connections
         WHERE twitch_user_id = ? AND did <> ?
       )`,
    ).bind(userId, did),
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

/** ユーザーが有効な Bluesky セッションを連携済みか。 */
export async function getBskyDidForUser(
  env: AppEnv,
  userId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT did FROM bsky_connections
     WHERE twitch_user_id = ? AND status = 'active'`,
  )
    .bind(userId)
    .first<{ did: string }>();
  return row?.did ?? null;
}

/** Bluesky 連携を解除する(リボーク + 連携・セッション削除)。 */
export async function disconnectBsky(
  env: AppEnv,
  userId: string,
): Promise<void> {
  const connection = await getBskyConnectionForUser(env, userId);
  if (!connection) return;
  try {
    await (await getOAuthClient(env)).revoke(connection.did);
  } catch (err) {
    // リボーク失敗時もローカル連携解除は完了させる。
    logError("bsky", "oauth revoke failed during disconnect", err, {
      userId,
      did: connection.did,
    });
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
