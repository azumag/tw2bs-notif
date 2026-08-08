import type { AppEnv } from "../types";

export const BSKY_BASE_URL = "https://bsky.social";
const SESSION_CACHE_KEY = "bsky:session";

const STATUS_COLLECTION = "app.bsky.actor.status";
const STATUS_RKEY = "self";
const MAX_SWAP_RETRIES = 5;
// サーバー側で4時間にクランプされるため、大きめの値を設定する(docs/bluesky-status-api.md 参照)
const DURATION_MINUTES = 720;

export interface LiveStatusRecord {
  $type: "app.bsky.actor.status";
  status: "app.bsky.actor.status#live";
  createdAt: string;
  durationMinutes: number;
  embed: {
    $type: "app.bsky.embed.external";
    external: {
      $type: "app.bsky.embed.external#external";
      uri: string;
      title: string;
      description: string;
    };
  };
}

interface SessionCache {
  accessJwt: string;
  did: string;
  expires_at: number;
}

export class BlueskyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly error?: string,
  ) {
    super(message);
    this.name = "BlueskyError";
  }
}

async function bskyFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let error: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      error = body.error;
      message = body.message ?? error ?? message;
    } catch {
      // ボディがJSONでない場合はステータスコードのみ
    }
    throw new BlueskyError(res.status, message, error);
  }
  return res;
}

interface SessionResponse {
  accessJwt: string;
  did: string;
}

export async function getSession(env: AppEnv): Promise<SessionCache> {
  const cached = await env.STATE.get<SessionCache>(SESSION_CACHE_KEY, "json");
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return cached;
  }

  const res = await bskyFetch(`${BSKY_BASE_URL}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: env.BSKY_HANDLE,
      password: env.BSKY_APP_PASSWORD,
    }),
  });
  const data = (await res.json()) as SessionResponse;
  if (!data.accessJwt || !data.did) {
    throw new BlueskyError(502, "invalid session response from Bluesky");
  }

  const session: SessionCache = {
    accessJwt: data.accessJwt,
    did: data.did,
    expires_at: Date.now() + 100 * 60 * 1000,
  };
  await env.STATE.put(SESSION_CACHE_KEY, JSON.stringify(session), {
    expirationTtl: 110 * 60,
  });
  return session;
}

async function getStatusRecordCid(
  env: AppEnv,
  session: SessionCache,
): Promise<string | null> {
  try {
    const res = await bskyFetch(
      `${BSKY_BASE_URL}/xrpc/com.atproto.repo.getRecord?repo=${session.did}&collection=${STATUS_COLLECTION}&rkey=${STATUS_RKEY}`,
      { headers: { Authorization: `Bearer ${session.accessJwt}` } },
    );
    const data = (await res.json()) as { cid?: string };
    return data.cid ?? null;
  } catch (err) {
    // record が未作成の場合 getRecord は 400 RecordNotFound を返す(初回設定パス)
    if (err instanceof BlueskyError && err.error === "RecordNotFound") {
      return null;
    }
    throw err;
  }
}

async function putStatusRecord(
  env: AppEnv,
  session: SessionCache,
  record: LiveStatusRecord,
  swapRecord: string | null,
): Promise<void> {
  await bskyFetch(`${BSKY_BASE_URL}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: session.did,
      collection: STATUS_COLLECTION,
      rkey: STATUS_RKEY,
      record,
      swapRecord,
    }),
  });
}

export async function setLiveStatus(
  env: AppEnv,
  input: { uri: string; title?: string; description?: string },
): Promise<void> {
  await withSessionRefresh(env, async (session) => {
    const record: LiveStatusRecord = {
      $type: "app.bsky.actor.status",
      status: "app.bsky.actor.status#live",
      createdAt: new Date().toISOString(),
      durationMinutes: DURATION_MINUTES,
      embed: {
        $type: "app.bsky.embed.external",
        external: {
          $type: "app.bsky.embed.external#external",
          uri: input.uri,
          // PDS は title を必須として検証する(空文字は許容)
          title: input.title ?? "",
          description: input.description ?? "",
        },
      },
    };

    for (let attempt = 0; attempt < MAX_SWAP_RETRIES; attempt++) {
      const existingCid = await getStatusRecordCid(env, session);
      try {
        await putStatusRecord(env, session, record, existingCid);
        return;
      } catch (err) {
        const isInvalidSwap =
          err instanceof BlueskyError && err.error === "InvalidSwap";
        if (!isInvalidSwap || attempt === MAX_SWAP_RETRIES - 1) {
          throw err;
        }
      }
    }
  });
}

export async function statusRecordExists(env: AppEnv): Promise<boolean> {
  const session = await getSession(env);
  return (await getStatusRecordCid(env, session)) !== null;
}

export async function clearLiveStatus(env: AppEnv): Promise<void> {
  await withSessionRefresh(env, async (session) => {
    try {
      await bskyFetch(`${BSKY_BASE_URL}/xrpc/com.atproto.repo.deleteRecord`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: session.did,
          collection: STATUS_COLLECTION,
          rkey: STATUS_RKEY,
        }),
      });
    } catch (err) {
      if (err instanceof BlueskyError && err.error === "RecordNotFound") {
        return;
      }
      throw err;
    }
  });
}

async function withSessionRefresh<T>(
  env: AppEnv,
  fn: (session: SessionCache) => Promise<T>,
): Promise<T> {
  const session = await getSession(env);
  try {
    return await fn(session);
  } catch (err) {
    if (!(err instanceof BlueskyError) || err.status !== 401) {
      throw err;
    }
    // JWT失効時はセッションを破棄して再作成し、1回だけリトライ
    await env.STATE.delete(SESSION_CACHE_KEY);
    const freshSession = await getSession(env);
    return fn(freshSession);
  }
}
