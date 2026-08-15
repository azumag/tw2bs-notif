import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/types";
import {
  processStreamEvent,
  processStreamRenewals,
  type StreamEvent,
} from "../src/lib/stream";
import { migrations } from "./migrations";

const blueskyModule = await import("../src/lib/bluesky");
const twitchModule = await import("../src/lib/twitch");
vi.mock("../src/lib/bluesky", () => ({
  setLiveStatus: vi.fn(async () => {}),
  clearLiveStatus: vi.fn(async () => {}),
  createStreamPost: vi.fn(async () => {}),
  statusRecordExists: vi.fn(async () => false),
  getSessionForUser: vi.fn(async () => ({
    did: "did:plc:test",
    fetchHandler: async () => new Response(),
  })),
}));
vi.mock("../src/lib/twitch", () => ({
  getStreamStatesBatch: vi.fn(async () => new Map()),
  getChannelInformation: vi.fn(async () => null),
}));

// 遅延投入された延長メッセージを捕まえる
let queued: Array<{ body: unknown; options?: { delaySeconds?: number } }> = [];

function makeEnv(): AppEnv {
  const e = {
    ...env,
    EVENTS: {
      send: vi.fn(async (body: unknown, options?: { delaySeconds?: number }) => {
        queued.push({ body, options });
      }),
    },
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    TWITCH_BROADCASTER_ID: "12345",
    BSKY_HANDLE: "test.bsky.social",
    BSKY_APP_PASSWORD: "test-app-password",
    ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    TWITCH_OAUTH_REDIRECT_URL: env.TWITCH_OAUTH_REDIRECT_URL,
    EVENTSUB_CALLBACK_URL: env.EVENTSUB_CALLBACK_URL,
  } as unknown as AppEnv;
  // wrangler.jsonc の vars がテスト env に注入されるため、既定は無効にする
  delete (e as unknown as Record<string, unknown>).BSKY_POST_ON_START;
  return e;
}

function mockStreamStates(streams: Map<string, unknown>) {
  vi.mocked(twitchModule.getStreamStatesBatch).mockResolvedValue(
    streams as never,
  );
}

// 配信中の記録(D1)を用意する
async function markLive(streamId = "stream-1") {
  await env.DB.prepare(
    `INSERT INTO live_streams (twitch_channel_id, stream_id, started_at)
     VALUES ('12345', ?, '2026-08-07T00:00:00Z')
     ON CONFLICT (twitch_channel_id) DO UPDATE SET stream_id = excluded.stream_id`,
  )
    .bind(streamId)
    .run();
}

async function liveRecord(): Promise<{ streamId: string } | null> {
  return env.DB.prepare(
    "SELECT stream_id AS streamId FROM live_streams WHERE twitch_channel_id = '12345'",
  ).first<{ streamId: string }>();
}

const onlineEvent: StreamEvent = {
  id: "stream-1",
  type: "stream.online",
  broadcasterUserId: "12345",
  broadcasterUserLogin: "cool_user",
  startedAt: "2026-08-07T00:00:00Z",
};

const offlineEvent: StreamEvent = {
  type: "stream.offline",
  broadcasterUserId: "12345",
};

const streamState = {
  id: "stream-1",
  startedAt: "2026-08-07T00:00:00Z",
  title: "テスト配信",
  gameName: "Music",
  userLogin: "cool_user",
  thumbnailUrl:
    "https://static-cdn.jtvnw.net/previews-ttv/live_user_cool_user-{width}x{height}.jpg",
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

beforeEach(async () => {
  queued = [];
  await env.DB.prepare("DELETE FROM live_streams").run();
  await env.DB.prepare("DELETE FROM connections").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare(
    `INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name)
     VALUES ('user-1', 'test_user', 'テストユーザー')`,
  ).run();
  // チャネル 12345 の連携を用意
  await env.DB.prepare(
    `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
     VALUES ('user-1', '12345', 'cool_user', 'あずまぐ')`,
  ).run();
  vi.mocked(blueskyModule.setLiveStatus).mockReset();
  vi.mocked(blueskyModule.clearLiveStatus).mockReset();
  vi.mocked(blueskyModule.createStreamPost).mockReset();
  vi.mocked(blueskyModule.statusRecordExists).mockReset();
  vi.mocked(blueskyModule.getSessionForUser).mockReset();
  vi.mocked(blueskyModule.getSessionForUser).mockResolvedValue({
    did: "did:plc:test",
    fetchHandler: async () => new Response(),
  } as never);
  vi.mocked(blueskyModule.statusRecordExists).mockResolvedValue(false);
  vi.mocked(twitchModule.getStreamStatesBatch).mockReset();
  vi.mocked(twitchModule.getStreamStatesBatch).mockResolvedValue(
    new Map() as never,
  );
  vi.mocked(twitchModule.getChannelInformation).mockReset();
  vi.mocked(twitchModule.getChannelInformation).mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("processStreamEvent", () => {
  it("sets the live status and records state on stream.online", async () => {
    mockStreamStates(new Map([["12345", streamState]]));

    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledWith(expect.anything(), {
      uri: "https://www.twitch.tv/cool_user",
      title: "テスト配信",
      thumbnailUrl:
        "https://static-cdn.jtvnw.net/previews-ttv/live_user_cool_user-640x360.jpg",
    });
    expect(await liveRecord()).toEqual({ streamId: "stream-1" });
    // 4時間の失効前に延長する予約が入る(山をならすためのゆらぎ付き)
    expect(queued).toHaveLength(1);
    expect(queued[0].body).toEqual({
      type: "stream.renew",
      broadcasterUserId: "12345",
      streamId: "stream-1",
    });
    const delay = queued[0].options?.delaySeconds ?? 0;
    expect(delay).toBeGreaterThanOrEqual(3 * 60 * 60);
    expect(delay).toBeLessThan(3 * 60 * 60 + 30 * 60);
  });

  it("ignores events for channels without a connection", async () => {
    await processStreamEvent(makeEnv(), {
      ...onlineEvent,
      broadcasterUserId: "99999",
    });

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
  });

  it("ignores duplicate stream.online events for the same stream", async () => {
    await markLive("stream-1");

    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  it("falls back to the event login when the stream poll fails", async () => {
    vi.mocked(twitchModule.getStreamStatesBatch).mockRejectedValue(
      new Error("twitch down"),
    );

    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledWith(expect.anything(), {
      uri: "https://www.twitch.tv/cool_user",
      title: undefined,
      thumbnailUrl: undefined,
    });
  });

  it("creates a stream post when BSKY_POST_ON_START is enabled", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamEvent(e, onlineEvent);

    expect(blueskyModule.createStreamPost).toHaveBeenCalledWith(
      expect.anything(),
      {
        uri: "https://www.twitch.tv/cool_user",
        title: "テスト配信",
        text: "配信開始しました\nテスト配信\nMusic",
        thumbnailUrl:
          "https://static-cdn.jtvnw.net/previews-ttv/live_user_cool_user-640x360.jpg",
      },
    );
  });

  it("チャネル設定がOFFならバッジだけ反映して通常ポストは作成しない", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    await env.DB.prepare(
      `UPDATE connections SET post_on_start = 0
       WHERE user_id = 'user-1' AND twitch_channel_id = '12345'`,
    ).run();
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamEvent(e, onlineEvent);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(blueskyModule.createStreamPost).not.toHaveBeenCalled();
  });

  it("チャネル固有テンプレートへタイトル・カテゴリ・URLを展開する", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    await env.DB.prepare(
      `UPDATE connections
       SET post_template = '{channel} 配信中\n{title}\n{category}\n{url}',
           post_include_title = 1, post_include_category = 1
       WHERE user_id = 'user-1' AND twitch_channel_id = '12345'`,
    ).run();
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamEvent(e, onlineEvent);

    expect(blueskyModule.createStreamPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        text: "あずまぐ 配信中\nテスト配信\nMusic\nhttps://www.twitch.tv/cool_user",
      }),
    );
  });

  it("配信開始直後で /streams が未反映でもチャネル情報でタイトル・カテゴリを補う", async () => {
    // stream.online 直後、Helix /streams はまだこの配信を返さない
    mockStreamStates(new Map());
    vi.mocked(twitchModule.getChannelInformation).mockResolvedValue({
      title: "週末の雑談配信",
      gameName: "Just Chatting",
    } as never);
    await env.DB.prepare(
      `UPDATE connections
       SET post_template = '{title} #twitch\n{category}'
       WHERE user_id = 'user-1' AND twitch_channel_id = '12345'`,
    ).run();
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamEvent(e, onlineEvent);

    expect(blueskyModule.createStreamPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        text: "週末の雑談配信 #twitch\nJust Chatting",
      }),
    );
    // 配信中ステータスの埋め込みタイトルにも反映する
    expect(blueskyModule.setLiveStatus).toHaveBeenCalledWith(expect.anything(), {
      uri: "https://www.twitch.tv/cool_user",
      title: "週末の雑談配信",
      thumbnailUrl: undefined,
    });
  });

  it("/streams が返す情報があればチャネル情報は取りに行かない", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamEvent(e, onlineEvent);

    expect(twitchModule.getChannelInformation).not.toHaveBeenCalled();
  });

  it("does not create a stream post when the flag is off", async () => {
    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.createStreamPost).not.toHaveBeenCalled();
  });

  it("keeps setting the live status even when the post fails", async () => {
    vi.mocked(blueskyModule.createStreamPost).mockRejectedValue(
      new Error("bsky down"),
    );
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamEvent(e, onlineEvent);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(await liveRecord()).toEqual({ streamId: "stream-1" });
  });

  it("updates the state when a new stream id arrives while live", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    await markLive("stream-old");

    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(await liveRecord()).toEqual({ streamId: "stream-1" });
  });

  it("skips Bluesky writes when the user has no bsky session", async () => {
    vi.mocked(blueskyModule.getSessionForUser).mockResolvedValue(null);

    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    // 配信中の記録は残る
    expect(await liveRecord()).toEqual({ streamId: "stream-1" });
  });

  it("clears the live status on stream.offline when live", async () => {
    await markLive();

    await processStreamEvent(makeEnv(), offlineEvent);

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
    expect(await liveRecord()).toBeNull();
  });

  it("ignores stream.offline when not live", async () => {
    await processStreamEvent(makeEnv(), offlineEvent);

    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
  });

  it("ignores repeated stream.offline deliveries", async () => {
    await markLive();
    mockStreamStates(new Map());

    await processStreamEvent(makeEnv(), offlineEvent);
    await processStreamEvent(makeEnv(), offlineEvent);

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
  });

  it("skips stream.offline when the stream is actually still live", async () => {
    await markLive();
    mockStreamStates(new Map([["12345", streamState]]));

    await processStreamEvent(makeEnv(), offlineEvent);

    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
    // 配信中の記録も残したままにする
    expect(await liveRecord()).toEqual({ streamId: "stream-1" });
  });

  it("clears on stream.offline even when the verify poll fails", async () => {
    await markLive();
    vi.mocked(twitchModule.getStreamStatesBatch).mockRejectedValue(
      new Error("twitch down"),
    );

    await processStreamEvent(makeEnv(), offlineEvent);

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
  });

  it("catches failures without throwing", async () => {
    vi.mocked(blueskyModule.setLiveStatus).mockRejectedValue(
      new Error("bsky down"),
    );

    await expect(processStreamEvent(makeEnv(), onlineEvent)).resolves.toBeUndefined();
  });
});

describe("processStreamRenewals", () => {
  const renewal = {
    type: "stream.renew" as const,
    broadcasterUserId: "12345",
    streamId: "stream-1",
  };

  it("配信が続いていればバッジを書き直し、次の延長を予約する", async () => {
    await markLive("stream-1");
    mockStreamStates(new Map([["12345", streamState]]));
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamRenewals(e, [renewal]);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    // 延長時もバッチ取得済みの配信情報からサムネイルを引き継ぐ
    expect(blueskyModule.setLiveStatus).toHaveBeenCalledWith(expect.anything(), {
      uri: "https://www.twitch.tv/cool_user",
      title: "テスト配信",
      thumbnailUrl:
        "https://static-cdn.jtvnw.net/previews-ttv/live_user_cool_user-640x360.jpg",
    });
    // 延長では通常ポストを作らない
    expect(blueskyModule.createStreamPost).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
    expect(queued[0].body).toEqual(renewal);
  });

  it("配信が終わっていたらバッジを消さず、記録だけ片付ける", async () => {
    await markLive("stream-1");
    mockStreamStates(new Map());

    await processStreamRenewals(makeEnv(), [renewal]);

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    // 消すのは stream.offline の役割。ここでは触らず自然失効に任せる
    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
    expect(await liveRecord()).toBeNull();
  });

  it("別の配信に入れ替わっていたら延長しない", async () => {
    await markLive("stream-2");
    mockStreamStates(new Map([["12345", streamState]]));

    await processStreamRenewals(makeEnv(), [renewal]);

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
    // 新しい配信の記録は残す
    expect(await liveRecord()).toEqual({ streamId: "stream-2" });
  });

  it("配信中の記録が無ければ何もしない", async () => {
    mockStreamStates(new Map([["12345", streamState]]));

    await processStreamRenewals(makeEnv(), [renewal]);

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  it("バッチ内の生存確認は Helix 1リクエストにまとめる", async () => {
    await env.DB.prepare(
      `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('user-1', '67890', 'second_user', '別チャネル')`,
    ).run();
    await markLive("stream-1");
    await env.DB.prepare(
      `INSERT INTO live_streams (twitch_channel_id, stream_id) VALUES ('67890', 'stream-2')`,
    ).run();
    mockStreamStates(
      new Map([
        ["12345", streamState],
        ["67890", { ...streamState, id: "stream-2", userLogin: "second_user" }],
      ]),
    );

    await processStreamRenewals(makeEnv(), [
      renewal,
      renewal, // 同じチャネルの重複は畳まれる
      { type: "stream.renew", broadcasterUserId: "67890", streamId: "stream-2" },
    ]);

    // チャネルが増えても問い合わせは1回きり
    expect(twitchModule.getStreamStatesBatch).toHaveBeenCalledTimes(1);
    expect(twitchModule.getStreamStatesBatch).toHaveBeenCalledWith(
      expect.anything(),
      ["12345", "67890"],
    );
    expect(queued).toHaveLength(2);
  });
});

// マルチチャネル利用時、Blueskyの配信中ステータス(ユーザーにつき1レコード)を
// どのチャネル基準で調停するか。既存の単一チャネル(12345, user-1)に加えて
// 同じユーザーの2本目のチャネル(67890)を A/B として使う。
describe("マルチチャネル: ユーザー単位のBluesky配信中ステータス調停", () => {
  const channelA = "12345";
  const channelB = "67890";

  function stateFor(
    overrides: Partial<typeof streamState> & { id: string; userLogin: string },
  ) {
    return { ...streamState, ...overrides };
  }

  // getStreamStatesBatch は問い合わせたチャネルIDだけを返す実際のAPIの挙動を模す
  function mockStreamStatesMap(map: Record<string, unknown>) {
    vi.mocked(twitchModule.getStreamStatesBatch).mockImplementation(
      async (_env, ids: string[]) => {
        const result = new Map<string, unknown>();
        for (const id of ids) {
          if (map[id]) result.set(id, map[id]);
        }
        return result as never;
      },
    );
  }

  function onlineEventFor(
    channelId: string,
    streamId: string,
    startedAt: string,
    login: string,
  ): StreamEvent {
    return {
      id: streamId,
      type: "stream.online",
      broadcasterUserId: channelId,
      broadcasterUserLogin: login,
      startedAt,
    };
  }

  function offlineEventFor(channelId: string): StreamEvent {
    return { type: "stream.offline", broadcasterUserId: channelId };
  }

  async function liveRecordFor(
    channelId: string,
  ): Promise<{ streamId: string } | null> {
    return env.DB.prepare(
      "SELECT stream_id AS streamId FROM live_streams WHERE twitch_channel_id = ?",
    )
      .bind(channelId)
      .first<{ streamId: string }>();
  }

  beforeEach(async () => {
    // channelA(12345)の連携はトップレベルの beforeEach で作成済み。channelB を追加する。
    await env.DB.prepare(
      `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('user-1', ?, 'b_user', 'チャンネルB')`,
    )
      .bind(channelB)
      .run();
  });

  it("Aのみ開始 → A表示", async () => {
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
    });

    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(blueskyModule.setLiveStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ uri: "https://www.twitch.tv/a_user" }),
    );
  });

  it("A開始後B開始 → B表示", async () => {
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user" }),
    });

    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelB, "b-1", "2026-08-15T10:30:00Z", "b_user"),
    );

    expect(blueskyModule.setLiveStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ uri: "https://www.twitch.tv/b_user" }),
    );
  });

  it("A・B配信中に非代表Aが終了してもB表示を維持し、Blueskyへは書き込まない", async () => {
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user" }),
    });
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelB, "b-1", "2026-08-15T10:30:00Z", "b_user"),
    );
    vi.mocked(blueskyModule.setLiveStatus).mockClear();
    vi.mocked(blueskyModule.clearLiveStatus).mockClear();

    // Aの終了確認: Helix には B のみ配信中として返る
    mockStreamStatesMap({
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user" }),
    });
    await processStreamEvent(makeEnv(), offlineEventFor(channelA));

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
    expect(await liveRecordFor(channelA)).toBeNull();
    expect(await liveRecordFor(channelB)).toEqual({ streamId: "b-1" });
  });

  it("A・B配信中に代表Bが終了するとAへ切り替わる", async () => {
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user" }),
    });
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelB, "b-1", "2026-08-15T10:30:00Z", "b_user"),
    );
    vi.mocked(blueskyModule.setLiveStatus).mockClear();

    // Bの終了確認: Helix には A のみ配信中として返る
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
    });
    await processStreamEvent(makeEnv(), offlineEventFor(channelB));

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(blueskyModule.setLiveStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ uri: "https://www.twitch.tv/a_user" }),
    );
    expect(await liveRecordFor(channelB)).toBeNull();
    expect(await liveRecordFor(channelA)).toEqual({ streamId: "a-1" });
  });

  it("最後の1チャネルが終了するとステータスを削除する", async () => {
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
    });
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );
    vi.mocked(blueskyModule.setLiveStatus).mockClear();

    mockStreamStatesMap({}); // 誰も配信していない
    await processStreamEvent(makeEnv(), offlineEventFor(channelA));

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
    expect(await liveRecordFor(channelA)).toBeNull();
  });

  it("A・Bが同時刻に開始しても決定的なルールで代表が決まる(到着順に依存しない)", async () => {
    const sameStart = "2026-08-15T10:00:00Z";
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user", startedAt: sameStart }),
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user", startedAt: sameStart }),
    });

    // A → B の順で到着
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", sameStart, "a_user"),
    );
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelB, "b-1", sameStart, "b_user"),
    );
    const afterAThenB = vi
      .mocked(blueskyModule.setLiveStatus)
      .mock.calls.at(-1)?.[1];

    // 記録をリセットし、B → A の順(逆順)で到着しても結果が変わらないことを確認する
    await env.DB.prepare("DELETE FROM live_streams").run();
    vi.mocked(blueskyModule.setLiveStatus).mockClear();
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-2", userLogin: "a_user", startedAt: sameStart }),
      [channelB]: stateFor({ id: "b-2", userLogin: "b_user", startedAt: sameStart }),
    });
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelB, "b-2", sameStart, "b_user"),
    );
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-2", sameStart, "a_user"),
    );
    const afterBThenA = vi
      .mocked(blueskyModule.setLiveStatus)
      .mock.calls.at(-1)?.[1];

    expect(afterAThenB).toEqual(afterBThenA);
  });

  it("非代表チャネルのrenewalはBlueskyの表示を奪わない", async () => {
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user" }),
    });
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelB, "b-1", "2026-08-15T10:30:00Z", "b_user"),
    );
    vi.mocked(blueskyModule.setLiveStatus).mockClear();
    queued = [];

    // 非代表(A)のrenewal: Blueskyには触れないが、生存確認と延長予約は続ける
    await processStreamRenewals(makeEnv(), [
      { type: "stream.renew", broadcasterUserId: channelA, streamId: "a-1" },
    ]);

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
    expect(queued[0].body).toEqual({
      type: "stream.renew",
      broadcasterUserId: channelA,
      streamId: "a-1",
    });
  });

  it("代表チャネルのrenewalは正常にBlueskyを更新する", async () => {
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user" }),
    });
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelB, "b-1", "2026-08-15T10:30:00Z", "b_user"),
    );
    vi.mocked(blueskyModule.setLiveStatus).mockClear();

    // 代表(B)のrenewal
    await processStreamRenewals(makeEnv(), [
      { type: "stream.renew", broadcasterUserId: channelB, streamId: "b-1" },
    ]);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(blueskyModule.setLiveStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uri: "https://www.twitch.tv/b_user" }),
    );
  });

  it("EventSubの重複online/offlineが届いても不整合を起こさない", async () => {
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user" }),
    });

    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );
    // Aのonlineが重複配信される
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );
    await processStreamEvent(
      makeEnv(),
      onlineEventFor(channelB, "b-1", "2026-08-15T10:30:00Z", "b_user"),
    );

    // Aの終了確認: Helix には B のみ配信中として返る
    mockStreamStatesMap({
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user" }),
    });
    await processStreamEvent(makeEnv(), offlineEventFor(channelA));
    // Aのofflineが重複配信される
    await processStreamEvent(makeEnv(), offlineEventFor(channelA));

    expect(await liveRecordFor(channelA)).toBeNull();
    expect(await liveRecordFor(channelB)).toEqual({ streamId: "b-1" });
    // Bの表示は最後まで消えない
    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
  });

  it("配信開始の通常ポストはA・Bそれぞれのチャネル設定に従って従来通り作成される", async () => {
    await env.DB.prepare(
      `UPDATE connections SET post_on_start = 1
       WHERE twitch_channel_id IN (?, ?)`,
    )
      .bind(channelA, channelB)
      .run();
    mockStreamStatesMap({
      [channelA]: stateFor({ id: "a-1", userLogin: "a_user" }),
      [channelB]: stateFor({ id: "b-1", userLogin: "b_user" }),
    });
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamEvent(
      e,
      onlineEventFor(channelA, "a-1", "2026-08-15T10:00:00Z", "a_user"),
    );
    await processStreamEvent(
      e,
      onlineEventFor(channelB, "b-1", "2026-08-15T10:30:00Z", "b_user"),
    );

    // Bが代表になっても、非代表になったAの配信開始ポストは独立して作られている
    expect(blueskyModule.createStreamPost).toHaveBeenCalledTimes(2);
    expect(blueskyModule.createStreamPost).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ uri: "https://www.twitch.tv/a_user" }),
    );
    expect(blueskyModule.createStreamPost).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ uri: "https://www.twitch.tv/b_user" }),
    );
  });
});
