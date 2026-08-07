import type { AppEnv } from "../types";

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
  const res = await twitchFetch(`${API_URL}/eventsub/subscriptions`, {
    headers: authHeaders(env, token),
  });
  const data = (await res.json()) as { data: TwitchSubscription[] };
  return data.data;
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
