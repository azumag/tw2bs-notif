import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/types";
import { WEBHOOK_SECRET_KEY } from "../src/lib/eventsub";
import type { QueueMessage } from "../src/lib/stream";
import { migrations } from "./migrations";

const blueskyModule = await import("../src/lib/bluesky");
vi.mock("../src/lib/bluesky", () => ({
  setLiveStatus: vi.fn(async () => {}),
  clearLiveStatus: vi.fn(async () => {}),
  createStreamPost: vi.fn(async () => {}),
  statusRecordExists: vi.fn(async () => false),
  getSessionForUser: vi.fn(async () => ({
    did: "did:plc:e2e",
    fetchHandler: async () => new Response(),
  })),
}));

function makeEnv(sendMock?: ReturnType<typeof vi.fn>): AppEnv {
  return {
    ...env,
    TWITCH_CLIENT_ID: "e2e-client-id",
    TWITCH_CLIENT_SECRET: "e2e-client-secret",
    TWITCH_BROADCASTER_ID: "12345",
    BSKY_HANDLE: "test.bsky.social",
    BSKY_APP_PASSWORD: "test-app-password",
    ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    TWITCH_OAUTH_REDIRECT_URL: env.TWITCH_OAUTH_REDIRECT_URL,
    EVENTSUB_CALLBACK_URL: env.EVENTSUB_CALLBACK_URL,
    EVENTS: sendMock
      ? ({ send: sendMock } as unknown as Queue<unknown>)
      : (env.EVENTS as unknown as Queue<unknown>),
  } as AppEnv;
}

type RouteHandler = (
  url: URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function mockFetch(routes: Record<string, RouteHandler>) {
  const mock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      for (const [pattern, handler] of Object.entries(routes)) {
        if (url.href.includes(pattern)) {
          return await handler(url, init);
        }
      }
      throw new Error(`unexpected request: ${url.href}`);
    },
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SECRET = "e2e-webhook-secret";
const MESSAGE_ID = "msg-1";
const freshTimestamp = () => new Date().toISOString();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sendEvent(
  payload: unknown,
  sendMock?: ReturnType<typeof vi.fn>,
): Promise<{ res: Response; ctx: ExecutionContext }> {
  const body = JSON.stringify(payload);
  const ts = freshTimestamp();
  const signature = `sha256=${await hmacHex(SECRET, MESSAGE_ID + ts + body)}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://example.com/twitch/eventsub", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Twitch-Eventsub-Message-Type": "notification",
        "Twitch-Eventsub-Message-Id": MESSAGE_ID,
        "Twitch-Eventsub-Message-Timestamp": ts,
        "Twitch-Eventsub-Message-Signature": signature,
      },
      body,
    }),
    makeEnv(sendMock),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, ctx };
}

/** Queue に溜まったイベントを consumer(queue ハンドラ)で処理する */
async function drainQueue(
  sendMock: ReturnType<typeof vi.fn>,
  env0: AppEnv,
): Promise<void> {
  const events: QueueMessage[] = sendMock.mock.calls.map(
    (c) => c[0] as QueueMessage,
  );
  if (events.length === 0) return;
  sendMock.mockClear();
  const messages = events.map((body) => ({
    body,
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts: 1,
  }));
  const batch = createMessageBatch<QueueMessage>("eventsub-events", messages);
  const ctx = createExecutionContext();
  await worker.queue?.(batch, env0);
  await waitOnExecutionContext(ctx);
}

const onlinePayload = {
  subscription: {
    id: "s1",
    type: "stream.online",
    version: "1",
    status: "enabled",
    created_at: "",
  },
  event: {
    id: "stream-100",
    broadcaster_user_id: "12345",
    broadcaster_user_login: "azumag",
    started_at: "2026-08-07T00:00:00Z",
  },
};

const offlinePayload = {
  subscription: {
    id: "s2",
    type: "stream.offline",
    version: "1",
    status: "enabled",
    created_at: "",
  },
  event: { broadcaster_user_id: "12345", broadcaster_user_login: "azumag" },
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations as D1Migration[]);
});

beforeEach(async () => {
  await env.STATE.put(WEBHOOK_SECRET_KEY, SECRET);
  await env.STATE.delete("twitch:token");
  await env.STATE.delete("bsky:session");
  // チャネル 12345 の連携を用意
  await env.DB.prepare("DELETE FROM live_streams").run();
  await env.DB.prepare("DELETE FROM connections").run();
  await env.DB.prepare(
    `INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name)
     VALUES ('user-1', '12345', 'azumag', 'あずまぐ')`,
  ).run();
  vi.mocked(blueskyModule.setLiveStatus).mockReset();
  vi.mocked(blueskyModule.clearLiveStatus).mockReset();
  vi.mocked(blueskyModule.createStreamPost).mockReset();
  vi.mocked(blueskyModule.statusRecordExists).mockReset();
  vi.mocked(blueskyModule.getSessionForUser).mockReset();
  vi.mocked(blueskyModule.getSessionForUser).mockResolvedValue({
    did: "did:plc:e2e",
    fetchHandler: async () => new Response(),
  } as never);
  vi.mocked(blueskyModule.statusRecordExists).mockResolvedValue(false);
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("E2E: Twitch EventSub → Bluesky streaming status", () => {
  it("sets the live status on stream.online and clears it on stream.offline", async () => {
    let streamPollCalls = 0;

    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({ access_token: "twitch-token", expires_in: 5000000, token_type: "bearer" }),
      "api.twitch.tv/helix/streams?user_id=12345": async () => {
        // 1回目(online 時の取得): 配信中。以降(offline 時の検証): 配信終了済み
        streamPollCalls++;
        return streamPollCalls === 1
          ? jsonResponse({
              data: [
                {
                  id: "stream-100",
                  user_id: "12345",
                  user_login: "azumag",
                  started_at: "2026-08-07T00:00:00Z",
                  title: "E2Eテスト配信",
                  game_name: "Music",
                },
              ],
            })
          : jsonResponse({ data: [] });
      },
    });

    // stream.online → キュー投入 → consumer 処理 → Bluesky に設定
    const sendMock = vi.fn(async () => {});
    const env0 = makeEnv(sendMock);
    const online = await sendEvent(onlinePayload, sendMock);
    expect(online.res.status).toBe(202);
    await drainQueue(sendMock, env0);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(blueskyModule.setLiveStatus).toHaveBeenCalledWith(
      expect.anything(),
      { uri: "https://www.twitch.tv/azumag", title: "E2Eテスト配信" },
    );
    expect(blueskyModule.createStreamPost).toHaveBeenCalledWith(
      expect.anything(),
      {
        uri: "https://www.twitch.tv/azumag",
        title: "E2Eテスト配信",
        text: "配信開始しました\nE2Eテスト配信\nMusic",
      },
    );

    const live = await env.DB.prepare(
      "SELECT stream_id AS streamId FROM live_streams WHERE twitch_channel_id = '12345'",
    ).first<{ streamId: string }>();
    expect(live?.streamId).toBe("stream-100");

    // stream.offline → キュー投入 → consumer 処理 → ステータス削除
    const offline = await sendEvent(offlinePayload, sendMock);
    expect(offline.res.status).toBe(202);
    await drainQueue(sendMock, env0);

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);

    const after = await env.DB.prepare(
      "SELECT stream_id FROM live_streams WHERE twitch_channel_id = '12345'",
    ).first();
    expect(after).toBeNull();
  });

  it("does not double-apply on duplicate online deliveries", async () => {
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({ access_token: "twitch-token", expires_in: 5000000, token_type: "bearer" }),
      "api.twitch.tv/helix/streams?user_id=12345": async () =>
        jsonResponse({ data: [] }),
    });

    const sendMock = vi.fn(async () => {});
    const env0 = makeEnv(sendMock);
    await sendEvent(onlinePayload, sendMock);
    await sendEvent(onlinePayload, sendMock); // 同じ stream id の再送
    await drainQueue(sendMock, env0);

    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);
  });

  it("4時間の失効前に、キューの遅延メッセージでバッジを延長する", async () => {
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({ access_token: "twitch-token", expires_in: 5000000, token_type: "bearer" }),
      "api.twitch.tv/helix/streams?user_id=12345": async () =>
        jsonResponse({
          data: [
            {
              id: "stream-100",
              user_id: "12345",
              user_login: "azumag",
              started_at: "2026-08-07T00:00:00Z",
              title: "E2Eテスト配信",
              game_name: "Music",
            },
          ],
        }),
    });

    const sendMock = vi.fn(async () => {});
    const env0 = makeEnv(sendMock);

    // 配信開始 → バッジ設定 + 延長メッセージの予約
    await sendEvent(onlinePayload, sendMock);
    await drainQueue(sendMock, env0);
    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(1);

    const sentCalls = () =>
      sendMock.mock.calls as unknown as Array<
        [unknown, { delaySeconds?: number } | undefined]
      >;
    const renewal = sentCalls().at(-1);
    expect(renewal?.[0]).toEqual({
      type: "stream.renew",
      broadcasterUserId: "12345",
      streamId: "stream-100",
    });
    // 失効(4時間)より前に戻ってくる
    const delaySeconds = renewal?.[1]?.delaySeconds;
    expect(delaySeconds).toBeGreaterThanOrEqual(3 * 60 * 60);
    expect(delaySeconds).toBeLessThan(4 * 60 * 60);

    // 遅延メッセージが届いた: バッジを書き直し、次の延長をまた予約する
    const postsBefore = vi.mocked(blueskyModule.createStreamPost).mock.calls.length;
    await drainQueue(sendMock, env0);
    expect(blueskyModule.setLiveStatus).toHaveBeenCalledTimes(2);
    // 延長では通常ポストを作らない
    expect(blueskyModule.createStreamPost).toHaveBeenCalledTimes(postsBefore);
    expect(sentCalls().at(-1)?.[0]).toMatchObject({
      type: "stream.renew",
      streamId: "stream-100",
    });
  });

  it("延長時に配信が終わっていたら、バッジは消さず自然失効に任せる", async () => {
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({ access_token: "twitch-token", expires_in: 5000000, token_type: "bearer" }),
      "api.twitch.tv/helix/streams?user_id=12345": async () =>
        jsonResponse({ data: [] }),
    });
    await env.DB.prepare(
      `INSERT INTO live_streams (twitch_channel_id, stream_id) VALUES ('12345', 'stream-100')`,
    ).run();

    const sendMock = vi.fn(async () => {});
    const env0 = makeEnv(sendMock);
    const batch = createMessageBatch<QueueMessage>("eventsub-events", [
      {
        body: {
          type: "stream.renew",
          broadcasterUserId: "12345",
          streamId: "stream-100",
        },
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
      },
    ]);
    await worker.queue?.(batch, env0);

    expect(blueskyModule.setLiveStatus).not.toHaveBeenCalled();
    expect(blueskyModule.clearLiveStatus).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    const row = await env.DB.prepare(
      "SELECT stream_id FROM live_streams WHERE twitch_channel_id = '12345'",
    ).first();
    expect(row).toBeNull();
  });
});
