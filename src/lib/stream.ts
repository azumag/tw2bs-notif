import type { AppEnv } from "../types";
import { STREAM_ONLINE, STREAM_RENEW } from "../types";
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
import {
  findConnectionsByChannel,
  listConnections,
  type Connection,
} from "./connections";
import {
  getLiveStream,
  getLiveStreamsByChannels,
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

// Twitch の thumbnail_url は {width}x{height} プレースホルダを含むため、実寸に置換する
const THUMB_WIDTH = 640;
const THUMB_HEIGHT = 360;

function thumbnailUrl(stream: StreamState | null): string | undefined {
  if (!stream?.thumbnailUrl) return undefined;
  return stream.thumbnailUrl
    .replace("{width}", String(THUMB_WIDTH))
    .replace("{height}", String(THUMB_HEIGHT));
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

/** Bluesky の配信中ステータス(embed)に必要な情報。 */
interface StreamInfo {
  title?: string;
  category?: string;
  thumbnailUrl?: string;
  login?: string;
}

/**
 * チャネルのタイトル・カテゴリ・サムネイルを取得する。
 *
 * stream.online の Webhook にはタイトルもカテゴリも含まれず、Helix /streams は
 * 配信開始直後にはまだこの配信を返さないことがある。その場合 title/category が
 * 空のまま扱われてしまうため、チャネル情報(/channels)で補う。
 *
 * `opts.stream` を渡すとバッチ取得済みの結果を再利用し、問い合わせを省く。
 */
async function fetchStreamInfo(
  env: AppEnv,
  channelId: string,
  opts?: { stream?: StreamState | null; loginOverride?: string },
): Promise<StreamInfo> {
  const stream =
    opts?.stream !== undefined
      ? opts.stream
      : await getStreamStatesBatch(env, [channelId])
          .then((m) => m.get(channelId) ?? null)
          .catch((err) => {
            logError(C, "stream poll failed", err);
            return null;
          });
  let title = stream?.title;
  let category = stream?.gameName;
  if (!title || !category) {
    const channel = await getChannelInformation(env, channelId).catch((err) => {
      logError(C, "channel info fetch failed", err);
      return null;
    });
    if (channel) {
      title = title || channel.title;
      category = category || channel.gameName;
    }
  }
  return {
    title,
    category,
    thumbnailUrl: thumbnailUrl(stream),
    login: opts?.loginOverride ?? stream?.userLogin,
  };
}

/** チャネル設定に従って通常の配信開始ポストを作成する(失敗してもバッジ設定には影響させない)。 */
async function maybeCreateStreamPost(
  env: AppEnv,
  connection: Connection,
  info: StreamInfo,
): Promise<void> {
  const postOnStartEnabled =
    env.BSKY_POST_ON_START === "true" && connection.postOnStart;
  if (!postOnStartEnabled) return;

  const session = await getSessionForUser(env, connection.userId);
  if (!session) {
    logInfo(C, "user has no bsky session, post skipped", {
      userId: connection.userId,
    });
    return;
  }
  const uri = twitchUrl(info.login ?? connection.twitchLogin);
  try {
    const text = formatStreamPostText(connection.postTemplate, {
      title: info.title,
      category: info.category,
      channel: connection.twitchDisplayName,
      url: uri,
    });
    await createStreamPost(session, {
      uri,
      title: info.title,
      thumbnailUrl: info.thumbnailUrl,
      text,
    });
  } catch (err) {
    logError(C, "stream post failed", err, { userId: connection.userId });
  }
}

/** ユーザーの配信中チャネルのうち、代表として選ばれたもの。 */
interface LiveCandidate {
  connection: Connection;
  streamId: string;
  startedAt: string | null;
}

function startedAtMs(startedAt: string | null): number {
  if (!startedAt) return -Infinity;
  const ms = Date.parse(startedAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * どちらの配信を代表とすべきかを判定する。「最後に配信を開始したチャネル」を
 * 優先し、startedAt が同一(または欠損)の場合はチャネルIDで決定的に選ぶ
 * (tie-break。同時刻に複数チャネルが開始しても結果が不定にならないようにする)。
 */
function isMoreRecent(a: LiveCandidate, b: LiveCandidate): boolean {
  const aMs = startedAtMs(a.startedAt);
  const bMs = startedAtMs(b.startedAt);
  if (aMs !== bMs) return aMs > bMs;
  return a.connection.twitchChannelId > b.connection.twitchChannelId;
}

/**
 * ユーザーに紐づくチャネルのうち、現在配信中のものを確認し、Bluesky に表示すべき
 * 代表チャネルを1つ選ぶ。配信中のチャネルが無ければ null。
 */
async function findRepresentative(
  env: AppEnv,
  userId: string,
): Promise<LiveCandidate | null> {
  const connections = await listConnections(env, userId);
  if (connections.length === 0) return null;
  const liveByChannel = await getLiveStreamsByChannels(
    env,
    connections.map((c) => c.twitchChannelId),
  );
  let best: LiveCandidate | null = null;
  for (const connection of connections) {
    const live = liveByChannel.get(connection.twitchChannelId);
    if (!live) continue;
    const candidate: LiveCandidate = {
      connection,
      streamId: live.streamId,
      startedAt: live.startedAt,
    };
    if (!best || isMoreRecent(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * 代表チャネルの判定結果を Bluesky に反映する。代表が無ければステータスを削除し、
 * あれば setLiveStatus で書き込む。`hint` が代表チャネルと一致する場合は
 * 取得済みの StreamInfo を再利用し、問い合わせを省く。
 */
async function applyRepresentative(
  env: AppEnv,
  userId: string,
  representative: LiveCandidate | null,
  hint?: { channelId: string; info: StreamInfo },
): Promise<void> {
  const session = await getSessionForUser(env, userId);
  if (!session) {
    logInfo(C, "user has no bsky session, reconcile skipped", { userId });
    return;
  }
  if (!representative) {
    await clearLiveStatus(session);
    logInfo(C, "cleared live status (no live channel)", { userId });
    return;
  }
  const { connection, streamId } = representative;
  const info =
    hint?.channelId === connection.twitchChannelId
      ? hint.info
      : await fetchStreamInfo(env, connection.twitchChannelId);
  await setLiveStatus(session, {
    uri: twitchUrl(info.login ?? connection.twitchLogin),
    title: info.title,
    thumbnailUrl: info.thumbnailUrl,
  });
  logInfo(C, "set live", {
    userId,
    channelId: connection.twitchChannelId,
    streamId,
  });
}

/**
 * ユーザー単位で Bluesky の配信中ステータスを調停する。
 *
 * Bluesky の配信中ステータスは1ユーザーにつき1レコードしか持てないため、
 * マルチチャネル利用時は「最後に配信を開始したチャネル」だけを代表として表示する。
 * 代表が既に正しいチャネルを指している場合でも setLiveStatus を呼び直す
 * (renewal による延長を兼ねるため)。呼び出し側で「代表チャネルの変化がない
 * 場合は呼ばない」という判断をすることで、不要な書き込みを避けている。
 */
export async function reconcileUserLiveStatus(
  env: AppEnv,
  userId: string,
  hint?: { channelId: string; info: StreamInfo },
): Promise<void> {
  const representative = await findRepresentative(env, userId);
  await applyRepresentative(env, userId, representative, hint);
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

      const info = await fetchStreamInfo(env, event.broadcasterUserId, {
        loginOverride: event.broadcasterUserLogin,
      });

      // 通常の配信開始ポストはチャネル単位(このチャネルの全connection)で作る。
      // 代表判定とは無関係に、各ユーザーのチャネル設定に従う。
      for (const connection of connections) {
        await maybeCreateStreamPost(env, connection, info);
      }
      // Blueskyの配信中バッジはユーザー単位で調停する(他チャネルが既に代表なら上書きしない)。
      for (const connection of connections) {
        await reconcileUserLiveStatus(env, connection.userId, {
          channelId: event.broadcasterUserId,
          info,
        });
      }

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

    // live_streams から消す前に「このチャネルが各ユーザーの代表だったか」を控えておく。
    // 非代表チャネルが終了しただけなら、他ユーザーが表示中の代表を消してはいけない。
    const wasRepresentative = new Map<string, boolean>();
    for (const connection of connections) {
      const before = await findRepresentative(env, connection.userId);
      wasRepresentative.set(
        connection.userId,
        before?.connection.twitchChannelId === event.broadcasterUserId,
      );
    }

    await markStreamOffline(env, event.broadcasterUserId);

    for (const connection of connections) {
      if (!wasRepresentative.get(connection.userId)) {
        logInfo(C, "non-representative channel ended, status kept", {
          userId: connection.userId,
          channelId: event.broadcasterUserId,
        });
        continue;
      }
      // 代表チャネルが終了した: 他にまだ配信中のチャネルがあればそちらへ切り替え、
      // 無ければステータスを削除する(reconcileUserLiveStatus が両方担う)。
      await reconcileUserLiveStatus(env, connection.userId);
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
 *
 * Bluesky へ書き込むのは、そのチャネルが現在ユーザーの代表である場合だけ。
 * 非代表チャネルの renewal は生存確認と次回スケジュールの継続のみ行い、
 * 代表が表示しているステータスを奪わない。
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

        const connections = await findConnectionsByChannel(env, channelId);
        let info: StreamInfo | null = null;
        for (const connection of connections) {
          const representative = await findRepresentative(env, connection.userId);
          if (representative?.connection.twitchChannelId !== channelId) {
            logInfo(C, "non-representative renewal, bsky untouched", {
              userId: connection.userId,
              channelId,
            });
            continue;
          }
          // バッチ取得済みの結果をそのまま使う(チャネルごとの再問い合わせを避ける)
          info ??= await fetchStreamInfo(env, channelId, { stream });
          await applyRepresentative(env, connection.userId, representative, {
            channelId,
            info,
          });
        }

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
