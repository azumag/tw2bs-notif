import type { AppEnv } from "../types";
import { STREAM_OFFLINE, STREAM_ONLINE } from "../types";
import { clearLiveStatus, setLiveStatus, statusRecordExists } from "./bluesky";
import { getStreamState } from "./twitch";
import { logError, logInfo } from "./logger";

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
    if (
      !event.broadcasterUserId ||
      event.broadcasterUserId !== env.TWITCH_BROADCASTER_ID
    ) {
      logInfo(C, "ignored other/missing broadcaster", {
        broadcaster: event.broadcasterUserId ?? "(none)",
      });
      return;
    }
    const key = stateKey(env.TWITCH_BROADCASTER_ID);
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
      const stream = await getStreamState(env, env.TWITCH_BROADCASTER_ID).catch(
        (err) => {
          logError(C, "stream poll failed", err);
          return null;
        },
      );
      const login = event.broadcasterUserLogin ?? stream?.userLogin;
      await setLiveStatus(env, { uri: twitchUrl(login), title: stream?.title });
      await env.STATE.put(
        key,
        JSON.stringify({
          is_live: true,
          stream_id: event.id ?? stream?.id,
          started_at: event.startedAt ?? stream?.startedAt,
          updated_at: new Date().toISOString(),
        } satisfies LiveState),
      );
      logInfo(C, "set live", {
        streamId: event.id ?? stream?.id,
        uri: twitchUrl(login),
      });
    } else {
      // stream.offline (id は存在しない)
      if (!state?.is_live) {
        logInfo(C, "offline without live state, skipped");
        return;
      }
      // 誤消灯防止: 遅延到達した前配信の offline が、新しい配信中に来るケースを防ぐ。
      // Helix が配信中を示したらスキップ。API 失敗時は EventSub を信用してクリアする。
      const stillLive = await getStreamState(
        env,
        env.TWITCH_BROADCASTER_ID,
      ).catch((err) => {
        logError(C, "offline verify poll failed", err);
        return null;
      });
      if (stillLive) {
        logInfo(C, "stream is still live, offline skipped", {
          streamId: stillLive.id,
        });
        return;
      }
      await clearLiveStatus(env);
      await env.STATE.put(
        key,
        JSON.stringify({
          is_live: false,
          updated_at: new Date().toISOString(),
        } satisfies LiveState),
      );
      logInfo(C, "cleared live status");
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
    const key = stateKey(env.TWITCH_BROADCASTER_ID);
    const state = await env.STATE.get<LiveState>(key, "json");
    const stream = await getStreamState(env, env.TWITCH_BROADCASTER_ID);

    if (stream) {
      // 配信中: record を再書き込みし、expiresAt(最大4h)の失効をリセット
      const needsStateUpdate = !state?.is_live || state.stream_id !== stream.id;
      await setLiveStatus(env, {
        uri: twitchUrl(stream.userLogin),
        title: stream.title,
      });
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
      const recordExists = await statusRecordExists(env);
      if (state?.is_live || recordExists) {
        await clearLiveStatus(env);
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
  } catch (err) {
    logError(C, "refreshStreamStatus failed", err);
  }
}
