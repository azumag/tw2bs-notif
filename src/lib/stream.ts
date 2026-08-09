import type { AppEnv } from "../types";
import { STREAM_OFFLINE, STREAM_ONLINE } from "../types";
import {
  clearLiveStatus,
  createStreamPost,
  getSessionForUser,
  setLiveStatus,
  statusRecordExists,
} from "./bluesky";
import { getStreamStatesBatch } from "./twitch";
import { findConnectionsByChannel, listAllConnections } from "./connections";
import { logError, logInfo } from "./logger";
import { getPostOnStartEnabled } from "./user-preferences";

const C = "stream";

export interface StreamEvent {
  id?: string;
  type: "stream.online" | "stream.offline";
  broadcasterUserId: string;
  broadcasterUserLogin?: string;
  startedAt?: string;
}

export interface LiveState {
  is_live: boolean;
  stream_id?: string;
  started_at?: string;
  updated_at: string;
}

function stateKey(broadcasterUserId: string): string {
  return `stream:state:${broadcasterUserId}`;
}

function twitchUrl(login?: string): string {
  return login ? `https://www.twitch.tv/${login}` : "https://www.twitch.tv/";
}

export async function processStreamEvent(
  env: AppEnv,
  event: StreamEvent,
): Promise<void> {
  try {
    // connections に登録されたチャンネルのイベントのみ処理する
    if (!event.broadcasterUserId) {
      logInfo(C, "ignored missing broadcaster");
      return;
    }
    const connections = await findConnectionsByChannel(
      env,
      event.broadcasterUserId,
    );
    if (connections.length === 0) {
      logInfo(C, "ignored unknown channel", { channelId: event.broadcasterUserId });
      return;
    }

    const key = stateKey(event.broadcasterUserId);
    const state = await env.STATE.get<LiveState>(key, "json");

    if (event.type === STREAM_ONLINE) {
      // 重複排除: 同一配信(stream_id一致)の再送は無視
      if (state?.is_live && state.stream_id === event.id) {
        logInfo(C, "duplicate online event, skipped", {
          streamId: event.id,
        });
        return;
      }
      // 最新の配信情報(タイトル等)を取得。失敗時はログイン名のみで設定
      const stream = await getStreamStatesBatch(env, [event.broadcasterUserId])
        .then((m) => m.get(event.broadcasterUserId) ?? null)
        .catch((err) => {
          logError(C, "stream poll failed", err);
          return null;
        });
      const login = event.broadcasterUserLogin ?? stream?.userLogin;
      const input = { uri: twitchUrl(login), title: stream?.title };

      // 連携ユーザーごとに Bluesky へ反映
      for (const connection of connections) {
        const session = await getSessionForUser(env, connection.userId);
        if (!session) {
          logInfo(C, "user has no bsky session, skipped", {
            userId: connection.userId,
          });
          continue;
        }
        await setLiveStatus(session, input);
        const postOnStartEnabled =
          env.BSKY_POST_ON_START === "true" &&
          (await getPostOnStartEnabled(env, connection.userId).catch((err) => {
            logError(C, "post preference lookup failed", err, {
              userId: connection.userId,
            });
            return false;
          }));
        if (postOnStartEnabled) {
          try {
            await createStreamPost(session, input);
          } catch (err) {
            logError(C, "stream post failed", err, {
              userId: connection.userId,
            });
          }
        }
        logInfo(C, "set live", {
          userId: connection.userId,
          streamId: event.id ?? stream?.id,
        });
      }
      await env.STATE.put(
        key,
        JSON.stringify({
          is_live: true,
          stream_id: event.id ?? stream?.id,
          started_at: event.startedAt ?? stream?.startedAt,
          updated_at: new Date().toISOString(),
        } satisfies LiveState),
      );
    } else {
      // stream.offline (id は存在しない)
      if (!state?.is_live) {
        logInfo(C, "offline without live state, skipped");
        return;
      }
      // 誤消灯防止: 遅延到達した前配信の offline が、新しい配信中に来るケースを防ぐ。
      // Helix が配信中を示したらスキップ。API 失敗時は EventSub を信用してクリアする。
      const stillLive = await getStreamStatesBatch(env, [event.broadcasterUserId])
        .then((m) => m.get(event.broadcasterUserId) ?? null)
        .catch((err) => {
          logError(C, "offline verify poll failed", err);
          return null;
        });
      if (stillLive) {
        logInfo(C, "stream is still live, offline skipped", {
          streamId: stillLive.id,
        });
        return;
      }
      for (const connection of connections) {
        const session = await getSessionForUser(env, connection.userId);
        if (!session) {
          continue;
        }
        await clearLiveStatus(session);
        logInfo(C, "cleared live status", { userId: connection.userId });
      }
      await env.STATE.put(
        key,
        JSON.stringify({
          is_live: false,
          updated_at: new Date().toISOString(),
        } satisfies LiveState),
      );
    }
  } catch (err) {
    // 失敗してもハンドラの応答には影響させない(waitUntil内で実行される)
    logError(C, "processStreamEvent failed", err, {
      eventId: event.id,
      type: event.type,
    });
  }
}

export async function refreshStreamStatus(env: AppEnv): Promise<void> {
  try {
    const connections = await listAllConnections(env);
    if (connections.length === 0) {
      return;
    }
    // 全連携チャンネルの配信状態をバッチ取得(100チャンネル/リクエスト)
    const states = await getStreamStatesBatch(
      env,
      connections.map((c) => c.twitchChannelId),
    );

    for (const connection of connections) {
      const key = stateKey(connection.twitchChannelId);
      const state = await env.STATE.get<LiveState>(key, "json");
      const stream = states.get(connection.twitchChannelId);
      const session = await getSessionForUser(env, connection.userId);

      if (stream) {
        // 配信中: record を再書き込みし、expiresAt(最大4h)の失効をリセット
        const needsStateUpdate = !state?.is_live || state.stream_id !== stream.id;
        if (session) {
          await setLiveStatus(session, {
            uri: twitchUrl(stream.userLogin),
            title: stream.title,
          });
        } else {
          logInfo(C, "user has no bsky session, refresh skipped", {
            userId: connection.userId,
          });
        }
        if (needsStateUpdate) {
          await env.STATE.put(
            key,
            JSON.stringify({
              is_live: true,
              stream_id: stream.id,
              started_at: stream.startedAt,
              updated_at: new Date().toISOString(),
            } satisfies LiveState),
          );
        }
        logInfo(C, "refreshed live status", { streamId: stream.id });
      } else {
        // 配信していない: KV が live のまま、または Bluesky record が残っている場合は自己修復
        const recordExists = session ? await statusRecordExists(session) : false;
        if (state?.is_live || recordExists) {
          if (session) {
            await clearLiveStatus(session);
          }
          await env.STATE.put(
            key,
            JSON.stringify({
              is_live: false,
              updated_at: new Date().toISOString(),
            } satisfies LiveState),
          );
          logInfo(C, "cleared stale live status", {
            stateWasLive: !!state?.is_live,
            recordExisted: recordExists,
          });
        }
      }
    }
  } catch (err) {
    logError(C, "refreshStreamStatus failed", err);
  }
}
