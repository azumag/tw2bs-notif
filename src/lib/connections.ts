import type { AppEnv } from "../types";

export interface Connection {
  id: number;
  userId: string;
  twitchChannelId: string;
  twitchLogin: string;
  twitchDisplayName: string;
  createdAt: string;
}

export async function listConnections(
  env: AppEnv,
  userId: string,
): Promise<Connection[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id AS userId, twitch_channel_id AS twitchChannelId,
            twitch_login AS twitchLogin, twitch_display_name AS twitchDisplayName,
            created_at AS createdAt
     FROM connections WHERE user_id = ? ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<Connection>();
  return results;
}

export async function findConnectionByChannel(
  env: AppEnv,
  userId: string,
  channelId: string,
): Promise<Connection | null> {
  return env.DB.prepare(
    `SELECT id, user_id AS userId, twitch_channel_id AS twitchChannelId,
            twitch_login AS twitchLogin, twitch_display_name AS twitchDisplayName,
            created_at AS createdAt
     FROM connections WHERE user_id = ? AND twitch_channel_id = ?`,
  )
    .bind(userId, channelId)
    .first<Connection>();
}

/** チャンネルに紐づく全 connections を返す(マルチユーザー対応) */
export async function findConnectionsByChannel(
  env: AppEnv,
  channelId: string,
): Promise<Connection[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id AS userId, twitch_channel_id AS twitchChannelId,
            twitch_login AS twitchLogin, twitch_display_name AS twitchDisplayName,
            created_at AS createdAt
     FROM connections WHERE twitch_channel_id = ?`,
  )
    .bind(channelId)
    .all<Connection>();
  return results;
}

/** 全 connections を返す */
export async function listAllConnections(
  env: AppEnv,
): Promise<Connection[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id AS userId, twitch_channel_id AS twitchChannelId,
            twitch_login AS twitchLogin, twitch_display_name AS twitchDisplayName,
            created_at AS createdAt
     FROM connections ORDER BY created_at ASC`,
  ).all<Connection>();
  return results;
}

export async function insertConnection(
  env: AppEnv,
  userId: string,
  channel: { id: string; login: string; displayName: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
     VALUES (?, ?, ?, ?)
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
