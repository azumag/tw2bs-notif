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
import type { StreamEvent } from "../src/lib/stream";
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
  const events: StreamEvent[] = sendMock.mock.calls.map((c) => c[0] as StreamEvent);
  if (events.length === 0) return;
  sendMock.mockClear();
  const messages = events.map((body) => ({
    body,
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts: 1,
  }));
  const batch = createMessageBatch<StreamEvent>("eventsub-events", messages);
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
  await env.STATE.delete("stream:state:12345");
  await env.STATE.delete("twitch:token");
  await env.STATE.delete("bsky:session");
  // チャンネル 12345 の連携を用意
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
                  broadcaster_user_id: "12345",
                  started_at: "2026-08-07T00:00:00Z",
                  title: "E2Eテスト配信",
                  user_login: "azumag",
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

    const state = (await env.STATE.get("stream:state:12345", "json")) as {
      is_live: boolean;
      stream_id?: string;
    };
    expect(state.is_live).toBe(true);
    expect(state.stream_id).toBe("stream-100");

    // stream.offline → キュー投入 → consumer 処理 → ステータス削除
    const offline = await sendEvent(offlinePayload, sendMock);
    expect(offline.res.status).toBe(202);
    await drainQueue(sendMock, env0);

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);

    const after = (await env.STATE.get("stream:state:12345", "json")) as {
      is_live: boolean;
    };
    expect(after.is_live).toBe(false);
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

  it("self-heals via cron when the stream ended but KV still says live", async () => {
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({ access_token: "twitch-token", expires_in: 5000000, token_type: "bearer" }),
      "api.twitch.tv/helix/streams?user_id=12345": async () =>
        jsonResponse({ data: [] }),
    });

    // offline イベントを取りこぼした状態を再現: KV は live、実態は配信終了
    await env.STATE.put(
      "stream:state:12345",
      JSON.stringify({
        is_live: true,
        stream_id: "stream-100",
        started_at: "2026-08-07T00:00:00Z",
        updated_at: new Date().toISOString(),
      }),
    );

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://example.com/"),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200); // fetch ハンドラは cron でないのでダミー

    // scheduled ハンドラを直接呼ぶ(実デプロイでは cron が 30分毎に実行)
    const controller = createScheduledController({
      cron: "0,30 * * * *",
      scheduledTime: new Date(),
    });
    await worker.scheduled?.(controller, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(blueskyModule.clearLiveStatus).toHaveBeenCalledTimes(1);
    const state = (await env.STATE.get("stream:state:12345", "json")) as {
      is_live: boolean;
    };
    expect(state.is_live).toBe(false);
  });
});
