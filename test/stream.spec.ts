import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/types";
import {
  processStreamEvent,
  refreshStreamStatus,
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
}));

function makeEnv(): AppEnv {
  const e = {
    ...env,
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    TWITCH_BROADCASTER_ID: "12345",
    BSKY_HANDLE: "test.bsky.social",
    BSKY_APP_PASSWORD: "test-app-password",
    ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    TWITCH_OAUTH_REDIRECT_URL: env.TWITCH_OAUTH_REDIRECT_URL,
    EVENTSUB_CALLBACK_URL: env.EVENTSUB_CALLBACK_URL,
  } as AppEnv;
  // wrangler.jsonc の vars がテスト env に注入されるため、既定は無効にする
  delete (e as unknown as Record<string, unknown>).BSKY_POST_ON_START;
  return e;
}

function mockStreamStates(streams: Map<string, unknown>) {
  vi.mocked(twitchModule.getStreamStatesBatch).mockResolvedValue(
    streams as never,
  );
}

const stateKey = "stream:state:12345";

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
  userLogin: "cool_user",
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM connections").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare(
    `INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name)
     VALUES ('user-1', 'test_user', 'テストユーザー')`,
  ).run();
  // チャンネル 12345 の連携を用意
  await env.DB.prepare(
    `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
     VALUES ('user-1', '12345', 'cool_user', 'あずまぐ')`,
  ).run();
  await env.STATE.delete(stateKey);
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
    });
    const state = (await env.STATE.get(stateKey, "json")) as {
      is_live: boolean;
      stream_id?: string;
    };
    expect(state.is_live).toBe(true);
    expect(state.stream_id).toBe("stream-1");
  });

  it("ignores events for channels without a connection", async () => {
    await processStreamEvent(makeEnv(), {
      ...onlineEvent,
      broadcasterUserId: "99999",
    });

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
  });

  it("ignores duplicate stream.online events for the same stream", async () => {
    await env.STATE.put(
      stateKey,
      JSON.stringify({
        is_live: true,
        stream_id: "stream-1",
        updated_at: new Date().toISOString(),
      }),
    );

    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
  });

  it("falls back to the event login when the stream poll fails", async () => {
    vi.mocked(twitchModule.getStreamStatesBatch).mockRejectedValue(
      new Error("twitch down"),
    );

    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledWith(expect.anything(), {
      uri: "https://www.twitch.tv/cool_user",
      title: undefined,
    });
  });

  it("creates a stream post when BSKY_POST_ON_START is enabled", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamEvent(e, onlineEvent);

    expect(blueskyModule.createStreamPost).toHaveBeenCalledWith(
      expect.anything(),
      { uri: "https://www.twitch.tv/cool_user", title: "テスト配信" },
    );
  });

  it("ユーザー設定がOFFならバッジだけ反映して通常ポストは作成しない", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    await env.DB.prepare(
      `UPDATE users SET bsky_post_on_start = 0
       WHERE twitch_user_id = 'user-1'`,
    ).run();
    const e = makeEnv() as AppEnv & { BSKY_POST_ON_START?: string };
    e.BSKY_POST_ON_START = "true";

    await processStreamEvent(e, onlineEvent);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(blueskyModule.createStreamPost).not.toHaveBeenCalled();
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
    const state = (await env.STATE.get(stateKey, "json")) as {
      is_live: boolean;
    };
    expect(state.is_live).toBe(true);
  });

  it("updates the state when a new stream id arrives while live", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    await env.STATE.put(
      stateKey,
      JSON.stringify({
        is_live: true,
        stream_id: "stream-old",
        updated_at: new Date().toISOString(),
      }),
    );

    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    const state = (await env.STATE.get(stateKey, "json")) as {
      stream_id?: string;
    };
    expect(state.stream_id).toBe("stream-1");
  });

  it("skips Bluesky writes when the user has no bsky session", async () => {
    vi.mocked(blueskyModule.getSessionForUser).mockResolvedValue(null);

    await processStreamEvent(makeEnv(), onlineEvent);

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    // KV 状態は更新される
    const state = (await env.STATE.get(stateKey, "json")) as {
      is_live: boolean;
    };
    expect(state.is_live).toBe(true);
  });

  it("clears the live status on stream.offline when live", async () => {
    await env.STATE.put(
      stateKey,
      JSON.stringify({
        is_live: true,
        stream_id: "stream-1",
        updated_at: new Date().toISOString(),
      }),
    );

    await processStreamEvent(makeEnv(), offlineEvent);

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
    const state = (await env.STATE.get(stateKey, "json")) as {
      is_live: boolean;
    };
    expect(state.is_live).toBe(false);
  });

  it("ignores stream.offline when not live", async () => {
    await processStreamEvent(makeEnv(), offlineEvent);

    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
  });

  it("ignores repeated stream.offline deliveries", async () => {
    await env.STATE.put(
      stateKey,
      JSON.stringify({
        is_live: true,
        stream_id: "stream-1",
        updated_at: new Date().toISOString(),
      }),
    );
    mockStreamStates(new Map());

    await processStreamEvent(makeEnv(), offlineEvent);
    await processStreamEvent(makeEnv(), offlineEvent);

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
  });

  it("skips stream.offline when the stream is actually still live", async () => {
    await env.STATE.put(
      stateKey,
      JSON.stringify({
        is_live: true,
        stream_id: "stream-1",
        updated_at: new Date().toISOString(),
      }),
    );
    mockStreamStates(new Map([["12345", streamState]]));

    await processStreamEvent(makeEnv(), offlineEvent);

    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
  });

  it("clears on stream.offline even when the verify poll fails", async () => {
    await env.STATE.put(
      stateKey,
      JSON.stringify({
        is_live: true,
        stream_id: "stream-1",
        updated_at: new Date().toISOString(),
      }),
    );
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

describe("refreshStreamStatus", () => {
  it("refreshes the live status when streaming and KV is live", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    await env.STATE.put(
      stateKey,
      JSON.stringify({
        is_live: true,
        stream_id: "stream-1",
        updated_at: new Date().toISOString(),
      }),
    );

    await refreshStreamStatus(makeEnv());

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(blueskyModule.setLiveStatus).toHaveBeenCalledWith(expect.anything(), {
      uri: "https://www.twitch.tv/cool_user",
      title: "テスト配信",
    });
    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
  });

  it("self-heals when streaming but KV is not live", async () => {
    mockStreamStates(new Map([["12345", streamState]]));

    await refreshStreamStatus(makeEnv());

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    const state = (await env.STATE.get(stateKey, "json")) as {
      is_live: boolean;
    };
    expect(state.is_live).toBe(true);
  });

  it("clears the stale live status when not streaming", async () => {
    mockStreamStates(new Map([["12345", null]]));
    await env.STATE.put(
      stateKey,
      JSON.stringify({
        is_live: true,
        stream_id: "stream-1",
        updated_at: new Date().toISOString(),
      }),
    );

    await refreshStreamStatus(makeEnv());

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
    const state = (await env.STATE.get(stateKey, "json")) as {
      is_live: boolean;
    };
    expect(state.is_live).toBe(false);
  });

  it("clears the stale live status when the Bluesky record still exists but KV is offline", async () => {
    mockStreamStates(new Map([["12345", null]]));
    vi.mocked(blueskyModule.statusRecordExists).mockResolvedValue(true);

    await refreshStreamStatus(makeEnv());

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
    const state = (await env.STATE.get(stateKey, "json")) as {
      is_live: boolean;
    };
    expect(state.is_live).toBe(false);
  });

  it("does not update KV when the refresh setLiveStatus fails", async () => {
    mockStreamStates(new Map([["12345", streamState]]));
    vi.mocked(blueskyModule.setLiveStatus).mockRejectedValue(
      new Error("bsky down"),
    );

    await expect(refreshStreamStatus(makeEnv())).resolves.toBeUndefined();
    await expect(env.STATE.get(stateKey)).resolves.toBeNull();
  });

  it("does nothing when there are no connections", async () => {
    await env.DB.prepare("DELETE FROM connections").run();

    await refreshStreamStatus(makeEnv());

    expect(twitchModule.getStreamStatesBatch).not.toHaveBeenCalled();
  });

  it("does nothing when not streaming and KV is not live", async () => {
    mockStreamStates(new Map([["12345", null]]));

    await refreshStreamStatus(makeEnv());

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
  });

  it("catches failures without throwing", async () => {
    vi.mocked(twitchModule.getStreamStatesBatch).mockRejectedValue(
      new Error("twitch down"),
    );

    await expect(refreshStreamStatus(makeEnv())).resolves.toBeUndefined();
  });
});
