import type { AppEnv } from "../types";
import { STREAM_OFFLINE, STREAM_ONLINE } from "../types";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_URL = "https://api.twitch.tv/helix";
const TOKEN_CACHE_KEY = "twitch:token";
const KV_TTL_MAX = 5_184_000; // KV expirationTtl 上限(60日)

let inflightToken: Promise<string> | undefined;

export interface TokenCache {
  access_token: string;
  expires_at: number;
}

export interface TwitchSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  transport: {
    method: string;
    callback: string;
  };
  created_at: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export class TwitchError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TwitchError";
  }
}

async function twitchFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ボディがJSONでない場合はステータスコードのみ
    }
    throw new TwitchError(res.status, message);
  }
  return res;
}

function authHeaders(env: AppEnv, token: string): HeadersInit {
  return {
    "Client-ID": env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${token}`,
  };
}

export async function getAppAccessToken(env: AppEnv): Promise<string> {
  const cached = await env.STATE.get<TokenCache>(TOKEN_CACHE_KEY, "json");
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return cached.access_token;
  }
  if (inflightToken) {
    return inflightToken;
  }
  inflightToken = (async () => {
    const params = new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    });
    const res = await twitchFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = (await res.json()) as Partial<TokenResponse>;
    if (!data.access_token || typeof data.expires_in !== "number") {
      throw new TwitchError(502, "invalid token response from Twitch");
    }

    const cache: TokenCache = {
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    await env.STATE.put(TOKEN_CACHE_KEY, JSON.stringify(cache), {
      expirationTtl: Math.min(data.expires_in, KV_TTL_MAX),
    });
    return data.access_token;
  })();
  try {
    return await inflightToken;
  } finally {
    inflightToken = undefined;
  }
}

export interface CreateSubscriptionInput {
  type: string;
  version: string;
  condition: Record<string, string>;
  callback: string;
  secret: string;
}

export interface StreamState {
  id: string;
  startedAt: string;
  title: string;
  gameName: string;
  userLogin: string;
  /** サムネイル URL({width}x{height} プレースホルダを含む) */
  thumbnailUrl: string;
}

export interface TwitchChannelInfo {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string | null;
}

/** app access token で公開Twitchチャネルをログイン名から取得する。 */
export async function fetchTwitchUserByLogin(
  env: AppEnv,
  login: string,
): Promise<TwitchChannelInfo | null> {
  const token = await getAppAccessToken(env);
  const url = new URL(`${API_URL}/users`);
  url.searchParams.set("login", login.trim().toLowerCase());
  const res = await twitchFetch(url.toString(), {
    headers: authHeaders(env, token),
  });
  const payload = (await res.json()) as {
    data?: Array<{
      id?: string;
      login?: string;
      display_name?: string;
      profile_image_url?: string;
    }>;
  };
  const user = payload.data?.[0];
  if (!user) return null;
  if (!user.id || !user.login || !user.display_name) {
    throw new TwitchError(502, "invalid user response from Twitch");
  }
  return {
    id: user.id,
    login: user.login,
    displayName: user.display_name,
    profileImageUrl: user.profile_image_url || null,
  };
}

export interface TwitchChannelInformation {
  title: string;
  gameName: string;
}

/**
 * チャネルに設定されている配信タイトル・カテゴリを取得する。
 *
 * stream.online の Webhook はタイトルもカテゴリも持たず、Helix /streams は
 * 配信開始直後にはまだその配信を返さないことがある。/channels は配信前から
 * 設定値を返すため、タイトル・カテゴリのフォールバックとして使う。
 */
export async function getChannelInformation(
  env: AppEnv,
  broadcasterId: string,
): Promise<TwitchChannelInformation | null> {
  const token = await getAppAccessToken(env);
  const url = new URL(`${API_URL}/channels`);
  url.searchParams.set("broadcaster_id", broadcasterId);
  const res = await twitchFetch(url.toString(), {
    headers: authHeaders(env, token),
  });
  const payload = (await res.json()) as {
    data?: Array<{ title?: string; game_name?: string }>;
  };
  const channel = payload.data?.[0];
  if (!channel) return null;
  return {
    title: channel.title ?? "",
    gameName: channel.game_name ?? "",
  };
}

export async function getStreamState(
  env: AppEnv,
  broadcasterId: string,
): Promise<StreamState | null> {
  const states = await getStreamStatesBatch(env, [broadcasterId]);
  return states.get(broadcasterId) ?? null;
}

/**
 * 複数チャネルの配信状態をバッチ取得する(100チャネル/リクエスト)。
 * 配信していないチャネルは null。
 */
export async function getStreamStatesBatch(
  env: AppEnv,
  broadcasterIds: string[],
): Promise<Map<string, StreamState | null>> {
  const result = new Map<string, StreamState | null>();
  const token = await getAppAccessToken(env);
  for (let i = 0; i < broadcasterIds.length; i += 100) {
    const chunk = broadcasterIds.slice(i, i + 100);
    const query = chunk
      .map((id) => `user_id=${encodeURIComponent(id)}`)
      .join("&");
    const res = await twitchFetch(`${API_URL}/streams?${query}`, {
      headers: authHeaders(env, token),
    });
    // Helix の Get Streams が返すのは user_id。broadcaster_user_id は
    // EventSub 側のフィールド名なので、ここで使うと必ず undefined になる。
    const data = (await res.json()) as {
      data: Array<{
        id: string;
        user_id: string;
        started_at: string;
        title: string;
        game_name: string;
        user_login: string;
        thumbnail_url: string;
      }>;
    };
    const found = new Set<string>();
    for (const stream of data.data) {
      if (!stream.user_id) continue;
      result.set(stream.user_id, {
        id: stream.id,
        startedAt: stream.started_at,
        title: stream.title,
        gameName: stream.game_name,
        userLogin: stream.user_login,
        thumbnailUrl: stream.thumbnail_url,
      });
      found.add(stream.user_id);
    }
    for (const id of chunk) {
      if (!found.has(id)) {
        result.set(id, null);
      }
    }
  }
  return result;
}

export async function createSubscription(
  env: AppEnv,
  input: CreateSubscriptionInput,
): Promise<TwitchSubscription> {
  const token = await getAppAccessToken(env);
  const res = await twitchFetch(`${API_URL}/eventsub/subscriptions`, {
    method: "POST",
    headers: {
      ...authHeaders(env, token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: input.type,
      version: input.version,
      condition: input.condition,
      transport: {
        method: "webhook",
        callback: input.callback,
        secret: input.secret,
      },
    }),
  });
  const data = (await res.json()) as { data: TwitchSubscription[] };
  return data.data[0];
}

export async function listSubscriptions(
  env: AppEnv,
): Promise<TwitchSubscription[]> {
  const token = await getAppAccessToken(env);
  const all: TwitchSubscription[] = [];
  let cursor: string | undefined;
  do {
    const suffix = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
    const res = await twitchFetch(`${API_URL}/eventsub/subscriptions${suffix}`, {
      headers: authHeaders(env, token),
    });
    const data = (await res.json()) as {
      data: TwitchSubscription[];
      pagination?: { cursor?: string };
    };
    all.push(...data.data);
    cursor = data.pagination?.cursor;
  } while (cursor);
  return all;
}

export async function deleteSubscription(
  env: AppEnv,
  id: string,
): Promise<void> {
  const token = await getAppAccessToken(env);
  await twitchFetch(
    `${API_URL}/eventsub/subscriptions?id=${encodeURIComponent(id)}`,
    { method: "DELETE", headers: authHeaders(env, token) },
  );
}

/**
 * チャネルに stream.online / stream.offline の購読を確保する。
 * 同一 type+condition の購読が存在すれば(ステータスを問わず)スキップする。
 * Twitch は同一条件の購読がどのステータスでも存在すると 409 を返すため。
 */
export async function ensureChannelSubscriptions(
  env: AppEnv,
  channelId: string,
  callback: string,
  secret: string,
): Promise<void> {
  const existing = await listSubscriptions(env);
  for (const type of [STREAM_ONLINE, STREAM_OFFLINE] as const) {
    const already = existing.some(
      (s) =>
        s.type === type && s.condition.broadcaster_user_id === channelId,
    );
    if (already) continue;
    try {
      await createSubscription(env, {
        type,
        version: "1",
        condition: { broadcaster_user_id: channelId },
        callback,
        secret,
      });
    } catch (err) {
      // 競合(二重クリック等)は正常系として扱う
      if (err instanceof TwitchError && err.status === 409) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * チャネルに対する購読を全て削除する。
 */
export async function removeChannelSubscriptions(
  env: AppEnv,
  channelId: string,
): Promise<void> {
  const existing = await listSubscriptions(env);
  for (const sub of existing) {
    if (
      sub.condition.broadcaster_user_id === channelId &&
      (sub.type === STREAM_ONLINE || sub.type === STREAM_OFFLINE)
    ) {
      await deleteSubscription(env, sub.id);
    }
  }
}
