import type { AppEnv } from "../types";

/**
 * 配信中のチャネルの記録。
 *
 * 「今まさに配信中のもの」だけを持つので、行数は同時配信数に比例する
 * (登録ユーザー数には比例しない)。バッジ更新はこの集合だけを相手にする。
 */
export interface LiveStream {
  twitchChannelId: string;
  streamId: string;
  startedAt: string | null;
}

interface LiveStreamRow {
  twitchChannelId: string;
  streamId: string;
  startedAt: string | null;
}

const COLUMNS = `twitch_channel_id AS twitchChannelId,
   stream_id AS streamId,
   started_at AS startedAt`;

/**
 * 配信開始を記録する。同じチャネルの行は新しい配信で置き換える。
 * 既に同じ stream_id が記録済みなら false を返す(EventSub の再送)。
 */
export async function markStreamLive(
  env: AppEnv,
  input: { twitchChannelId: string; streamId: string; startedAt?: string },
): Promise<boolean> {
  const existing = await getLiveStream(env, input.twitchChannelId);
  if (existing?.streamId === input.streamId) {
    return false;
  }
  await env.DB.prepare(
    `INSERT INTO live_streams (twitch_channel_id, stream_id, started_at)
     VALUES (?, ?, ?)
     ON CONFLICT (twitch_channel_id) DO UPDATE
       SET stream_id = excluded.stream_id,
           started_at = excluded.started_at,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(input.twitchChannelId, input.streamId, input.startedAt ?? null)
    .run();
  return true;
}

export async function getLiveStream(
  env: AppEnv,
  twitchChannelId: string,
): Promise<LiveStream | null> {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM live_streams WHERE twitch_channel_id = ?`,
  )
    .bind(twitchChannelId)
    .first<LiveStreamRow>();
  return row ?? null;
}

/**
 * 複数チャネルの配信中レコードをまとめて取得する。
 * マルチチャネル利用時、ユーザーに紐づく全チャネルの生存確認をまとめて行うのに使う。
 */
export async function getLiveStreamsByChannels(
  env: AppEnv,
  twitchChannelIds: string[],
): Promise<Map<string, LiveStream>> {
  const result = new Map<string, LiveStream>();
  if (twitchChannelIds.length === 0) return result;
  const placeholders = twitchChannelIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM live_streams WHERE twitch_channel_id IN (${placeholders})`,
  )
    .bind(...twitchChannelIds)
    .all<LiveStreamRow>();
  for (const row of results) {
    result.set(row.twitchChannelId, row);
  }
  return result;
}

/** 配信終了を記録する。実際に消えたときだけ true。 */
export async function markStreamOffline(
  env: AppEnv,
  twitchChannelId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM live_streams WHERE twitch_channel_id = ?",
  )
    .bind(twitchChannelId)
    .run();
  return result.meta.changes > 0;
}

/** バッジを延長したことを記録する(運用時の確認用)。 */
export async function touchLiveStream(
  env: AppEnv,
  twitchChannelId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE live_streams
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE twitch_channel_id = ?`,
  )
    .bind(twitchChannelId)
    .run();
}
