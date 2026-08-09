import type { AppEnv } from "../types";
import { STREAM_OFFLINE, STREAM_ONLINE, STREAM_RENEW } from "../types";
import {
  clearLiveStatus,
  createStreamPost,
  getSessionForUser,
  setLiveStatus,
} from "./bluesky";
import {
  getChannelInformation,
  getStreamStatesBatch,
  type StreamState,
} from "./twitch";
import { findConnectionsByChannel } from "./connections";
import {
  getLiveStream,
  markStreamLive,
  markStreamOffline,
  touchLiveStream,
} from "./live-streams";
import { logError, logInfo } from "./logger";
import { formatStreamPostText } from "./post-template";

const C = "stream";

/**
 * バッジの延長間隔。Bluesky は expiresAt を最大4時間にクランプするため、
 * 失効前に書き直す必要がある(docs/bluesky-status-api.md)。
 *
 * ちょうど同じ間隔で投げ直すと、同時に配信を始めた分がそのまま同時に
 * 戻ってくる。0〜30分のゆらぎを足して山をならす。
 */
const RENEW_BASE_SECONDS = 3 * 60 * 60;
const RENEW_JITTER_SECONDS = 30 * 60;

export interface StreamEvent {
  id?: string;
  type: "stream.online" | "stream.offline";
  broadcasterUserId: string;
  broadcasterUserLogin?: string;
  startedAt?: string;
}

/** 配信中バッジを延長するための内部メッセージ(遅延投入される)。 */
export interface StreamRenewal {
  type: "stream.renew";
  broadcasterUserId: string;
  streamId: string;
}

export type QueueMessage = StreamEvent | StreamRenewal;

export function isStreamRenewal(message: QueueMessage): message is StreamRenewal {
  return message.type === STREAM_RENEW;
}

function twitchUrl(login?: string): string {
  return login ? `https://www.twitch.tv/${login}` : "https://www.twitch.tv/";
}

function renewDelaySeconds(): number {
  return RENEW_BASE_SECONDS + Math.floor(Math.random() * RENEW_JITTER_SECONDS);
}

/** 次回のバッジ延長を遅延付きでキューへ入れる。 */
async function scheduleRenewal(
  env: AppEnv,
  broadcasterUserId: string,
  streamId: string,
): Promise<void> {
  const delaySeconds = renewDelaySeconds();
  await env.EVENTS.send(
    { type: STREAM_RENEW, broadcasterUserId, streamId } satisfies StreamRenewal,
    { delaySeconds },
  );
  logInfo(C, "scheduled badge renewal", {
    channelId: broadcasterUserId,
    streamId,
    delaySeconds,
  });
}

/**
 * 配信中バッジを立て、必要なら通常ポストも作成する。
 * online イベントと延長の両方から呼ぶ。
 */
async function applyLiveStatus(
  env: AppEnv,
  input: {
    broadcasterUserId: string;
    broadcasterUserLogin?: string;
    /** 通常ポストを作成するか(延長時は作らない) */
    post: boolean;
    /** 取得済みの配信情報。延長時はバッチ取得の結果を渡して問い合わせを省く */
    stream?: StreamState | null;
  },
): Promise<void> {
  const connections = await findConnectionsByChannel(
    env,
    input.broadcasterUserId,
  );
  if (connections.length === 0) return;

  const stream =
    input.stream !== undefined
      ? input.stream
      : await getStreamStatesBatch(env, [input.broadcasterUserId])
          .then((m) => m.get(input.broadcasterUserId) ?? null)
          .catch((err) => {
            logError(C, "stream poll failed", err);
            return null;
          });
  // stream.online の Webhook にはタイトルもカテゴリも含まれず、Helix /streams は
  // 配信開始直後にはまだこの配信を返さないことがある。その場合 title/category が
  // 空のまま投稿されてしまうため、チャネル情報(/channels)で補う。
  let title = stream?.title;
  let category = stream?.gameName;
  if (!title || !category) {
    const channel = await getChannelInformation(env, input.broadcasterUserId)
      .catch((err) => {
        logError(C, "channel info fetch failed", err);
        return null;
      });
    if (channel) {
      title = title || channel.title;
      category = category || channel.gameName;
    }
  }

  for (const connection of connections) {
    const login =
      input.broadcasterUserLogin ?? stream?.userLogin ?? connection.twitchLogin;
    const statusInput = { uri: twitchUrl(login), title };
    const session = await getSessionForUser(env, connection.userId);
    if (!session) {
      logInfo(C, "user has no bsky session, skipped", {
        userId: connection.userId,
      });
      continue;
    }
    await setLiveStatus(session, statusInput);
    if (input.post) {
      const postOnStartEnabled =
        env.BSKY_POST_ON_START === "true" && connection.postOnStart;
      if (postOnStartEnabled) {
        try {
          const text = formatStreamPostText(connection.postTemplate, {
            title,
            category,
            channel: connection.twitchDisplayName,
            url: statusInput.uri,
          });
          await createStreamPost(session, { ...statusInput, text });
        } catch (err) {
          logError(C, "stream post failed", err, {
            userId: connection.userId,
          });
        }
      }
    }
    logInfo(C, "set live", { userId: connection.userId });
  }
}

export async function processStreamEvent(
  env: AppEnv,
  event: StreamEvent,
): Promise<void> {
  try {
    // connections に登録されたチャネルのイベントのみ処理する
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

    if (event.type === STREAM_ONLINE) {
      // 重複排除: 同一配信の再送は無視する(D1は強整合なので判定が安定する)
      const streamId = event.id ?? event.broadcasterUserId;
      const isNew = await markStreamLive(env, {
        twitchChannelId: event.broadcasterUserId,
        streamId,
        startedAt: event.startedAt,
      });
      if (!isNew) {
        logInfo(C, "duplicate online event, skipped", { streamId });
        return;
      }
      await applyLiveStatus(env, {
        broadcasterUserId: event.broadcasterUserId,
        broadcasterUserLogin: event.broadcasterUserLogin,
        post: true,
      });
      // 4時間で失効するので、その前に延長する予約を入れる
      await scheduleRenewal(env, event.broadcasterUserId, streamId);
      return;
    }

    // stream.offline
    const record = await getLiveStream(env, event.broadcasterUserId);
    if (!record) {
      logInfo(C, "offline without live record, skipped");
      return;
    }
    // 誤消灯防止: 遅延到達した前配信の offline が、新しい配信中に来るケースを防ぐ。
    // offline イベントは配信IDを持たないため、Helix で現況を確かめる。
    // 確認は配信終了1回につき1リクエストなので、連携数には比例しない。
    // API 失敗時は EventSub を信用してクリアする。
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
    await markStreamOffline(env, event.broadcasterUserId);
    for (const connection of connections) {
      const session = await getSessionForUser(env, connection.userId);
      if (!session) continue;
      await clearLiveStatus(session);
      logInfo(C, "cleared live status", { userId: connection.userId });
    }
  } catch (err) {
    // 失敗してもハンドラの応答には影響させない(waitUntil内で実行される)
    logError(C, "processStreamEvent failed", err, {
      eventId: event.id,
      type: event.type,
    });
  }
}

/**
 * 配信中バッジを延長する。
 *
 * バッジを消すのは stream.offline だけの役割にしてある。ここで配信が
 * 見つからなくても消さずに放置するので、Helix が一時的に配信を返さなく
 * ても配信中のバッジを誤って落とすことがない(放っておけば4時間で失効する)。
 *
 * 生存確認は Helix へ1リクエスト100チャネルまでまとめられるので、
 * バッチ内の延長分は必ずまとめて問い合わせる。
 */
export async function processStreamRenewals(
  env: AppEnv,
  renewals: StreamRenewal[],
): Promise<void> {
  if (renewals.length === 0) return;
  try {
    // 同じチャネルが重複していたら1件に畳む
    const byChannel = new Map<string, StreamRenewal>();
    for (const renewal of renewals) {
      if (renewal.broadcasterUserId) {
        byChannel.set(renewal.broadcasterUserId, renewal);
      }
    }
    if (byChannel.size === 0) return;

    const states = await getStreamStatesBatch(env, [...byChannel.keys()]);

    for (const [channelId, renewal] of byChannel) {
      try {
        // 既に終了を受け取っている、または別の配信に入れ替わっていれば何もしない
        const record = await getLiveStream(env, channelId);
        if (!record || record.streamId !== renewal.streamId) {
          logInfo(C, "renewal superseded, skipped", {
            channelId,
            streamId: renewal.streamId,
          });
          continue;
        }
        const stream = states.get(channelId);
        if (!stream) {
          // 配信が見つからない。バッジは消さずに自然失効させる
          logInfo(C, "stream not live at renewal, left to expire", { channelId });
          await markStreamOffline(env, channelId);
          continue;
        }
        await applyLiveStatus(env, {
          broadcasterUserId: channelId,
          broadcasterUserLogin: stream.userLogin,
          post: false,
          // バッチ取得済みの結果をそのまま使う(チャネルごとの再問い合わせを避ける)
          stream,
        });
        await touchLiveStream(env, channelId);
        await scheduleRenewal(env, channelId, renewal.streamId);
        logInfo(C, "renewed live status", { channelId, streamId: stream.id });
      } catch (err) {
        logError(C, "renewal failed", err, { channelId });
      }
    }
  } catch (err) {
    logError(C, "processStreamRenewals failed", err);
  }
}
