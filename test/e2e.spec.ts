import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/types";
import { WEBHOOK_SECRET_KEY } from "../src/lib/eventsub";

function makeEnv(): AppEnv {
  return {
    ...env,
    TWITCH_CLIENT_ID: "e2e-client-id",
    TWITCH_CLIENT_SECRET: "e2e-client-secret",
    TWITCH_BROADCASTER_ID: "12345",
    BSKY_HANDLE: "test.bsky.social",
    BSKY_APP_PASSWORD: "test-app-password",
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
const sessionResponse = {
  accessJwt: "e2e-jwt",
  did: "did:plc:e2e",
  handle: "test.bsky.social",
};

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
    makeEnv(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, ctx };
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

beforeEach(async () => {
  await env.STATE.put(WEBHOOK_SECRET_KEY, SECRET);
  await env.STATE.delete("stream:state:12345");
  await env.STATE.delete("twitch:token");
  await env.STATE.delete("bsky:session");
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("E2E: Twitch EventSub → Bluesky streaming status", () => {
  it("sets the live status on stream.online and clears it on stream.offline", async () => {
    const putRecordBodies: Record<string, unknown>[] = [];
    const deleteRecordBodies: Record<string, unknown>[] = [];
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
                  started_at: "2026-08-07T00:00:00Z",
                  title: "E2Eテスト配信",
                  user_login: "azumag",
                },
              ],
            })
          : jsonResponse({ data: [] });
      },
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "com.atproto.repo.putRecord": async (_url, init) => {
        putRecordBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ uri: "at://did:plc:e2e/app.bsky.actor.status/self", cid: "cid-1" });
      },
      "com.atproto.repo.deleteRecord": async (_url, init) => {
        deleteRecordBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ commit: { cid: "cid-2", rev: "1" } });
      },
    });

    // stream.online → Bluesky に設定
    const online = await sendEvent(onlinePayload);
    expect(online.res.status).toBe(202);

    expect(putRecordBodies).toHaveLength(1);
    const put = putRecordBodies[0] as {
      collection: string;
      rkey: string;
      record: {
        status: string;
        embed: { external: { uri: string; title: string } };
      };
    };
    expect(put.collection).toBe("app.bsky.actor.status");
    expect(put.rkey).toBe("self");
    expect(put.record.embed.external.uri).toBe("https://www.twitch.tv/azumag");
    expect(put.record.embed.external.title).toBe("E2Eテスト配信");
    expect(put.record.status).toBe("app.bsky.actor.status#live");

    const state = (await env.STATE.get("stream:state:12345", "json")) as {
      is_live: boolean;
      stream_id?: string;
    };
    expect(state.is_live).toBe(true);
    expect(state.stream_id).toBe("stream-100");

    // stream.offline → ステータス削除
    const offline = await sendEvent(offlinePayload);
    expect(offline.res.status).toBe(202);

    expect(deleteRecordBodies).toHaveLength(1);
    expect(deleteRecordBodies[0].collection).toBe("app.bsky.actor.status");
    expect(deleteRecordBodies[0].rkey).toBe("self");

    const after = (await env.STATE.get("stream:state:12345", "json")) as {
      is_live: boolean;
    };
    expect(after.is_live).toBe(false);
  });

  it("does not double-apply on duplicate online deliveries", async () => {
    let putRecordCalls = 0;
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({ access_token: "twitch-token", expires_in: 5000000, token_type: "bearer" }),
      "api.twitch.tv/helix/streams?user_id=12345": async () =>
        jsonResponse({ data: [] }),
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "com.atproto.repo.putRecord": async () => {
        putRecordCalls++;
        return jsonResponse({ uri: "at://...", cid: "cid-1" });
      },
    });

    await sendEvent(onlinePayload);
    await sendEvent(onlinePayload); // 同じ stream id の再送

    expect(putRecordCalls).toBe(1);
  });

  it("self-heals via cron when the stream ended but KV still says live", async () => {
    const deleteRecordBodies: Record<string, unknown>[] = [];
    mockFetch({
      "id.twitch.tv/oauth2/token": async () =>
        jsonResponse({ access_token: "twitch-token", expires_in: 5000000, token_type: "bearer" }),
      "api.twitch.tv/helix/streams?user_id=12345": async () =>
        jsonResponse({ data: [] }),
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse({
          uri: "at://did:plc:e2e/app.bsky.actor.status/self",
          cid: "cid-1",
          value: {},
        }),
      "com.atproto.repo.deleteRecord": async (_url, init) => {
        deleteRecordBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ commit: { cid: "cid-2", rev: "1" } });
      },
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

    expect(deleteRecordBodies).toHaveLength(1);
    expect(deleteRecordBodies[0].rkey).toBe("self");
    const state = (await env.STATE.get("stream:state:12345", "json")) as {
      is_live: boolean;
    };
    expect(state.is_live).toBe(false);
  });
});
