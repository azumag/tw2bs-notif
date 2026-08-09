import type { AppEnv } from "../types";
import { getValidUserAccessToken, TwitchOAuthError } from "./twitch-oauth";

/**
 * Twitch サブスク判定(twica と同方式)。
 * - キャッシュ: 正常時1時間で再検証 / APIエラー時5分で再検証
 * - ユーザーの手動確認・解除スイッチに対応
 */

const CACHE_DURATION_MS = 60 * 60 * 1000; // 1時間
const ERROR_CACHE_DURATION_MS = 5 * 60 * 1000; // 5分

export interface SubCheckResult {
  hasSub: boolean | null;
  /** 認証エラー(スコープ欠落やトークン失効)か */
  authError: boolean;
}

/**
 * ユーザーが対象チャネル(broadcaster)をサブスクしているか判定する。
 * キャッシュ期限内は DB の結果を返す。期限切れは API で確認して保存する。
 */
export async function hasTwitchSub(
  env: AppEnv,
  userId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT twitch_sub_verified_at AS verifiedAt,
            twitch_has_sub AS hasSub,
            twitch_sub_check_disabled AS disabled
     FROM users WHERE twitch_user_id = ?`,
  )
    .bind(userId)
    .first<{ verifiedAt: string | null; hasSub: number | null; disabled: number }>();

  // 手動解除スイッチ → 常に false
  if (row?.disabled) {
    return false;
  }

  const verifiedAt = row?.verifiedAt ? new Date(row.verifiedAt).getTime() : 0;
  if (row && Date.now() - verifiedAt < CACHE_DURATION_MS) {
    return !!row.hasSub;
  }

  const { hasSub } = await checkTwitchSubViaApi(env, userId);
  if (hasSub !== null) {
    await env.DB.prepare(
      `UPDATE users SET twitch_sub_verified_at = ?, twitch_has_sub = ?
       WHERE twitch_user_id = ?`,
    )
      .bind(new Date().toISOString(), hasSub ? 1 : 0, userId)
      .run();
    return hasSub;
  }

  // API エラー(認証エラー含む): タイムスタンプのみ更新して短縮TTL(5分)で再試行し、前回値を維持する
  await env.DB.prepare(
    `UPDATE users SET twitch_sub_verified_at = ?
     WHERE twitch_user_id = ?`,
  )
    .bind(
      new Date(Date.now() - (CACHE_DURATION_MS - ERROR_CACHE_DURATION_MS)).toISOString(),
      userId,
    )
    .run();
  return !!row?.hasSub;
}

/**
 * Twitch API でサブスク状態を直接確認する。
 * ユーザーのアクセストークンが必要(user:read:subscriptions スコープ)。
 */
export async function checkTwitchSubViaApi(
  env: AppEnv,
  userId: string,
): Promise<SubCheckResult> {
  const broadcasterId = env.TWITCH_BROADCASTER_ID;
  if (!broadcasterId) {
    return { hasSub: null, authError: false };
  }

  try {
    const accessToken = await getValidUserAccessToken(env, userId);
    const url = `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${broadcasterId}&user_id=${userId}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": env.TWITCH_CLIENT_ID,
      },
    });

    if (res.status === 404) {
      // サブスクしていない(404 = 対象が見つからない)
      return { hasSub: false, authError: false };
    }
    if (!res.ok) {
      // 401/403(スコープ欠落・トークン失効)はキャッシュを更新しない
      if (res.status === 401 || res.status === 403) {
        return { hasSub: null, authError: true };
      }
      return { hasSub: null, authError: false };
    }
    const data = (await res.json()) as { data: unknown[] };
    return { hasSub: data.data.length > 0, authError: false };
  } catch (err) {
    if (err instanceof TwitchOAuthError) {
      return { hasSub: null, authError: true };
    }
    return { hasSub: null, authError: false };
  }
}

/** 手動確認: キャッシュを無視して API で最新状態を取得して保存する */
export async function refreshTwitchSubCheck(
  env: AppEnv,
  userId: string,
): Promise<boolean | null> {
  const { hasSub, authError } = await checkTwitchSubViaApi(env, userId);
  if (hasSub !== null) {
    await env.DB.prepare(
      `UPDATE users SET twitch_sub_verified_at = ?, twitch_has_sub = ?
       WHERE twitch_user_id = ?`,
    )
      .bind(new Date().toISOString(), hasSub ? 1 : 0, userId)
      .run();
  }
  if (authError) return null;
  return hasSub;
}

/** サブスク判定の手動解除スイッチを切り替える */
export async function setTwitchSubCheckDisabled(
  env: AppEnv,
  userId: string,
  disabled: boolean,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET twitch_sub_check_disabled = ? WHERE twitch_user_id = ?`,
  )
    .bind(disabled ? 1 : 0, userId)
    .run();
}
