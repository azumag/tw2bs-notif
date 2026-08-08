import type { AppEnv } from "../types";
import { encryptSecret } from "./crypto";

/**
 * Twitch OAuth(認可コードフロー)クライアント。
 * ユーザーのログイン・識別と、サブスク判定(#14)に使うユーザートークン取得が目的。
 */

const TWITCH_AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_API_URL = "https://api.twitch.tv/helix";

const OAUTH_STATE_PREFIX = "oauth_state:";
const OAUTH_STATE_TTL = 10 * 60; // 10分

export const TWITCH_LOGIN_SCOPES = "user:read:email";

export interface TwitchUserInfo {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string | null;
}

export interface TwitchTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export class TwitchOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwitchOAuthError";
  }
}

/** ログイン用の認可 URL を生成し、state を KV に保存する */
export async function buildLoginUrl(env: AppEnv): Promise<string> {
  const state = crypto.randomUUID().replaceAll("-", "");
  await env.STATE.put(`${OAUTH_STATE_PREFIX}${state}`, "1", {
    expirationTtl: OAUTH_STATE_TTL,
  });
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: env.TWITCH_OAUTH_REDIRECT_URL,
    response_type: "code",
    scope: TWITCH_LOGIN_SCOPES,
    state,
  });
  return `${TWITCH_AUTHORIZE_URL}?${params.toString()}`;
}

/** コールバックで受け取った code をトークンと交換する */
export async function exchangeCode(
  env: AppEnv,
  code: string,
): Promise<TwitchTokenSet> {
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: env.TWITCH_OAUTH_REDIRECT_URL,
  });
  const res = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TwitchOAuthError(`token exchange failed: HTTP ${res.status} ${body}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: (data.scope ?? "").split(" ").filter(Boolean),
  };
}

/** ユーザートークンで /helix/users を叩き、ユーザー情報を取得する */
export async function fetchTwitchUser(
  env: AppEnv,
  accessToken: string,
): Promise<TwitchUserInfo> {
  const res = await fetch(`${TWITCH_API_URL}/users`, {
    headers: {
      "Client-ID": env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    throw new TwitchOAuthError(`fetch user failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    data: Array<{
      id: string;
      login: string;
      display_name: string;
      profile_image_url?: string;
    }>;
  };
  const user = data.data[0];
  if (!user) {
    throw new TwitchOAuthError("user not found");
  }
  return {
    id: user.id,
    login: user.login,
    displayName: user.display_name,
    profileImageUrl: user.profile_image_url || null,
  };
}

/** state が KV にあるか検証し、あれば削除する(使い捨て) */
export async function consumeOAuthState(
  env: AppEnv,
  state: string,
): Promise<boolean> {
  const key = `${OAUTH_STATE_PREFIX}${state}`;
  const value = await env.STATE.get(key);
  if (value === null) return false;
  await env.STATE.delete(key);
  return true;
}

export async function upsertUserWithTokens(
  env: AppEnv,
  user: TwitchUserInfo,
  tokens: TwitchTokenSet,
): Promise<void> {
  const accessTokenEnc = await encryptSecret(env, tokens.accessToken);
  const refreshTokenEnc = await encryptSecret(env, tokens.refreshToken);
  await env.DB.prepare(
    `INSERT INTO users (
       twitch_user_id, twitch_username, twitch_display_name, twitch_profile_image_url,
       twitch_access_token_enc, twitch_refresh_token_enc, twitch_token_expires_at, twitch_scopes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (twitch_user_id) DO UPDATE SET
       twitch_username = excluded.twitch_username,
       twitch_display_name = excluded.twitch_display_name,
       twitch_profile_image_url = excluded.twitch_profile_image_url,
       twitch_access_token_enc = excluded.twitch_access_token_enc,
       twitch_refresh_token_enc = excluded.twitch_refresh_token_enc,
       twitch_token_expires_at = excluded.twitch_token_expires_at,
       twitch_scopes = excluded.twitch_scopes,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(
      user.id,
      user.login,
      user.displayName,
      user.profileImageUrl,
      accessTokenEnc,
      refreshTokenEnc,
      tokens.expiresAt,
      JSON.stringify(tokens.scopes),
    )
    .run();
}
