import type { AppEnv } from "../types";
import { STREAM_OFFLINE, STREAM_ONLINE } from "../types";
import { clearLiveStatus, setLiveStatus, statusRecordExists } from "./bluesky";
import { getStreamState } from "./twitch";

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
      console.log(
        "processStreamEvent: ignored other/missing broadcaster",
        event.broadcasterUserId,
      );
      return;
    }
    const key = stateKey(env.TWITCH_BROADCASTER_ID);
    const state = await env.STATE.get<LiveState>(key, "json");

    if (event.type === STREAM_ONLINE) {
      // 重複排除: 同一配信(stream_id一致)の再送は無視
      if (state?.is_live && state.stream_id === event.id) {
        console.log("processStreamEvent: duplicate online event, skipped");
        return;
      }
      // 最新の配信情報(タイトル等)を取得。失敗時はログイン名のみで設定
      const stream = await getStreamState(env, env.TWITCH_BROADCASTER_ID).catch(
        (err) => {
          console.log("processStreamEvent: stream poll failed", err);
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
      console.log("processStreamEvent: set live");
    } else {
      // stream.offline (id は存在しない)
      if (!state?.is_live) {
        console.log("processStreamEvent: offline without live state, skipped");
        return;
      }
      // 誤消灯防止: 遅延到達した前配信の offline が、新しい配信中に来るケースを防ぐ。
      // Helix が配信中を示したらスキップ。API 失敗時は EventSub を信用してクリアする。
      const stillLive = await getStreamState(
        env,
        env.TWITCH_BROADCASTER_ID,
      ).catch((err) => {
        console.log("processStreamEvent: offline verify poll failed", err);
        return null;
      });
      if (stillLive) {
        console.log("processStreamEvent: stream is still live, offline skipped");
        return;
      }
      await clearLiveStatus(env);
      await env.STATE.put(
        key,
        JSON.stringify({ is_live: false, updated_at: new Date().toISOString() } satisfies LiveState),
      );
      console.log("processStreamEvent: cleared live status");
    }
  } catch (err) {
    // 失敗してもハンドラの応答には影響させない(waitUntil内で実行される)
    console.error("processStreamEvent: failed", err);
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
      console.log("refreshStreamStatus: refreshed live status");
    } else {
      // 配信していない: KV が live のまま、または Bluesky record が残っている場合は自己修復
      const recordExists = await statusRecordExists(env);
      if (state?.is_live || recordExists) {
        await clearLiveStatus(env);
        await env.STATE.put(
          key,
          JSON.stringify({ is_live: false, updated_at: new Date().toISOString() } satisfies LiveState),
        );
        console.log("refreshStreamStatus: cleared stale live status");
      }
    }
  } catch (err) {
    console.error("refreshStreamStatus: failed", err);
  }
}
