import type { AppEnv } from "../types";

/** 配信開始時にBlueskyへ通常ポストするユーザー設定。既定値はON。 */
export async function getPostOnStartEnabled(
  env: AppEnv,
  userId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT bsky_post_on_start AS enabled
     FROM users WHERE twitch_user_id = ?`,
  )
    .bind(userId)
    .first<{ enabled: number }>();
  return row?.enabled !== 0;
}

/** ユーザー設定を保存する。対象ユーザーが存在した場合は true。 */
export async function setPostOnStartEnabled(
  env: AppEnv,
  userId: string,
  enabled: boolean,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE users SET bsky_post_on_start = ?,
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE twitch_user_id = ?`,
  )
    .bind(enabled ? 1 : 0, userId)
    .run();
  return result.meta.changes > 0;
}
