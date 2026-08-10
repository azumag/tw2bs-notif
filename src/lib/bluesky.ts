import type { AppEnv } from "../types";
import { getBskyDidForUser } from "./bsky-oauth";
import { detectFacets } from "./facets";

/**
 * Bluesky 書き込み(ユーザー別 OAuth セッション経由)。
 * 細粒度スコープ(PoC 確認済み): app.bsky.actor.status + app.bsky.feed.post + blob:image/*(thumb 用)。
 */

export const STATUS_COLLECTION = "app.bsky.actor.status";
export const STATUS_RKEY = "self";
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
      thumb?: ThumbRef;
    };
  };
}

export interface ThumbRef {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
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

/**
 * OAuth セッションで XRPC 呼び出しを行う(DPoP 付き、トークン自動リフレッシュ)。
 * session は @atproto/oauth-client の OAuthSession(fetchHandler を持つ)。
 */
export interface BskySessionLike {
  did: string;
  fetchHandler: (pathname: string, init?: RequestInit) => Promise<Response>;
}

async function xrpc(
  session: BskySessionLike,
  pathname: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await session.fetchHandler(pathname, init);
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
  return res.json();
}

async function getStatusRecordCid(
  session: BskySessionLike,
): Promise<string | null> {
  try {
    const data = (await xrpc(
      session,
      `/xrpc/com.atproto.repo.getRecord?repo=${session.did}&collection=${STATUS_COLLECTION}&rkey=${STATUS_RKEY}`,
    )) as { cid?: string };
    return data.cid ?? null;
  } catch (err) {
    // record が未作成の場合 getRecord は 400 RecordNotFound を返す(初回設定パス)
    if (err instanceof BlueskyError && err.error === "RecordNotFound") {
      return null;
    }
    throw err;
  }
}

/**
 * サムネイル画像をアップロードして blob 参照を返す。
 * 取得・アップロードに失敗した場合は null を返し、thumb なしで続行する(best effort)。
 */
async function uploadThumb(
  session: BskySessionLike,
  imageUrl: string,
): Promise<ThumbRef | null> {
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return null;
    }
    const body = await res.arrayBuffer();
    // uploadBlob の上限(1MB)を超える画像はアップロードしない
    if (body.byteLength > 1_000_000) {
      return null;
    }
    const data = (await xrpc(session, "/xrpc/com.atproto.repo.uploadBlob", {
      method: "POST",
      headers: {
        "Content-Type":
          res.headers.get("Content-Type") ?? "image/jpeg",
      },
      body,
    })) as { blob?: ThumbRef };
    // PDS が不正な blob(欠損フィールド)を返した場合は thumb なしで続行する
    const blob = data.blob;
    if (
      !blob ||
      blob.$type !== "blob" ||
      !blob.ref?.$link ||
      !blob.mimeType ||
      typeof blob.size !== "number"
    ) {
      return null;
    }
    return blob;
  } catch {
    return null;
  }
}

export interface ExternalEmbedInput {
  uri: string;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
}

/** embed.external を組み立てる(thumb は取得できた場合のみ付与) */
async function buildExternal(
  session: BskySessionLike,
  input: ExternalEmbedInput,
): Promise<LiveStatusRecord["embed"]> {
  const external: LiveStatusRecord["embed"]["external"] & { thumb?: ThumbRef } = {
    $type: "app.bsky.embed.external#external",
    uri: input.uri,
    // PDS は title を必須として検証する(空文字は許容)
    title: input.title ?? "",
    description: input.description ?? "",
  };
  if (input.thumbnailUrl) {
    const thumb = await uploadThumb(session, input.thumbnailUrl);
    if (thumb) {
      external.thumb = thumb;
    }
  }
  return { $type: "app.bsky.embed.external", external };
}

export async function setLiveStatus(
  session: BskySessionLike,
  input: ExternalEmbedInput,
): Promise<void> {
  const record: LiveStatusRecord = {
    $type: "app.bsky.actor.status",
    status: "app.bsky.actor.status#live",
    createdAt: new Date().toISOString(),
    durationMinutes: DURATION_MINUTES,
    embed: await buildExternal(session, input),
  };

  for (let attempt = 0; attempt < MAX_SWAP_RETRIES; attempt++) {
    const existingCid = await getStatusRecordCid(session);
    try {
      await xrpc(session, "/xrpc/com.atproto.repo.putRecord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: session.did,
          collection: STATUS_COLLECTION,
          rkey: STATUS_RKEY,
          record,
          swapRecord: existingCid,
        }),
      });
      return;
    } catch (err) {
      const isInvalidSwap =
        err instanceof BlueskyError && err.error === "InvalidSwap";
      if (!isInvalidSwap || attempt === MAX_SWAP_RETRIES - 1) {
        throw err;
      }
    }
  }
}

export async function clearLiveStatus(session: BskySessionLike): Promise<void> {
  try {
    await xrpc(session, "/xrpc/com.atproto.repo.deleteRecord", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
}

export async function statusRecordExists(
  session: BskySessionLike,
): Promise<boolean> {
  return (await getStatusRecordCid(session)) !== null;
}

export async function createStreamPost(
  session: BskySessionLike,
  input: ExternalEmbedInput & { text?: string },
): Promise<void> {
  const text =
    input.text ?? `配信開始しました${input.title ? `: ${input.title}` : ""}`;
  // URLやハッシュタグは facets を付けないとリンクにならない
  const facets = detectFacets(text);
  await xrpc(session, "/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text,
        ...(facets.length ? { facets } : {}),
        createdAt: new Date().toISOString(),
        langs: ["ja"],
        embed: await buildExternal(session, input),
      },
    }),
  });
}

/**
 * Twitch ユーザーの Bluesky セッションを復元する。
 * 未連携なら null。
 */
export async function getSessionForUser(
  env: AppEnv,
  userId: string,
): Promise<BskySessionLike | null> {
  const did = await getBskyDidForUser(env, userId);
  if (!did) return null;
  try {
    const { getOAuthClient } = await import("./bsky-oauth");
    const session = await getOAuthClient(env).restore(did);
    return {
      did: session.did,
      fetchHandler: (pathname, init) => session.fetchHandler(pathname, init),
    };
  } catch {
    return null;
  }
}
