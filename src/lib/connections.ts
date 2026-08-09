import type { AppEnv } from "../types";
import { DEFAULT_POST_TEMPLATE } from "./post-template";

export interface Connection {
  id: number;
  userId: string;
  twitchChannelId: string;
  twitchLogin: string;
  twitchDisplayName: string;
  postOnStart: boolean;
  postTemplate: string;
  createdAt: string;
}

interface ConnectionRow {
  id: number;
  userId: string;
  twitchChannelId: string;
  twitchLogin: string;
  twitchDisplayName: string;
  postOnStart: number;
  postTemplate: string;
  createdAt: string;
}

export interface ConnectionPostingSettings {
  postOnStart: boolean;
  postTemplate: string;
}

const CONNECTION_COLUMNS = `id, user_id AS userId, twitch_channel_id AS twitchChannelId,
  twitch_login AS twitchLogin, twitch_display_name AS twitchDisplayName,
  post_on_start AS postOnStart, post_template AS postTemplate,
  created_at AS createdAt`;

function toConnection(row: ConnectionRow): Connection {
  return {
    ...row,
    postOnStart: row.postOnStart !== 0,
  };
}

export async function listConnections(
  env: AppEnv,
  userId: string,
): Promise<Connection[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${CONNECTION_COLUMNS}
     FROM connections WHERE user_id = ? ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<ConnectionRow>();
  return results.map(toConnection);
}

export async function findConnectionByChannel(
  env: AppEnv,
  userId: string,
  channelId: string,
): Promise<Connection | null> {
  const row = await env.DB.prepare(
    `SELECT ${CONNECTION_COLUMNS}
     FROM connections WHERE user_id = ? AND twitch_channel_id = ?`,
  )
    .bind(userId, channelId)
    .first<ConnectionRow>();
  return row ? toConnection(row) : null;
}

/** チャネルに紐づく全 connections を返す(マルチユーザー対応) */
export async function findConnectionsByChannel(
  env: AppEnv,
  channelId: string,
): Promise<Connection[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${CONNECTION_COLUMNS}
     FROM connections WHERE twitch_channel_id = ?`,
  )
    .bind(channelId)
    .all<ConnectionRow>();
  return results.map(toConnection);
}

/** 全 connections を返す */
export async function listAllConnections(
  env: AppEnv,
): Promise<Connection[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${CONNECTION_COLUMNS}
     FROM connections ORDER BY created_at ASC`,
  ).all<ConnectionRow>();
  return results.map(toConnection);
}

export async function insertConnection(
  env: AppEnv,
  userId: string,
  channel: { id: string; login: string; displayName: string },
): Promise<void> {
  // 自動ポストは連携直後はOFFで始める(内容を確認してから有効化してもらう)。
  await env.DB.prepare(
    `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name, post_on_start)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT (user_id, twitch_channel_id) DO NOTHING`,
  )
    .bind(userId, channel.id, channel.login, channel.displayName)
    .run();
}

export async function deleteConnection(
  env: AppEnv,
  userId: string,
  connectionId: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM connections WHERE id = ? AND user_id = ?`,
  )
    .bind(connectionId, userId)
    .run();
  return result.meta.changes > 0;
}

/** 所有者を確認しながらチャネル別の自動ポスト設定を保存する。 */
export async function updateConnectionPostingSettings(
  env: AppEnv,
  userId: string,
  connectionId: number,
  settings: ConnectionPostingSettings,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE connections
     SET post_on_start = ?, post_template = ?
     WHERE id = ? AND user_id = ?`,
  )
    .bind(
      settings.postOnStart ? 1 : 0,
      settings.postTemplate || DEFAULT_POST_TEMPLATE,
      connectionId,
      userId,
    )
    .run();
  return result.meta.changes > 0;
}
