import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/types";
import {
  TwitchError,
  createSubscription,
  deleteSubscription,
  fetchTwitchUserByLogin,
  getAppAccessToken,
  getChannelInformation,
  getStreamState,
  getStreamStatesBatch,
  listSubscriptions,
} from "../src/lib/twitch";

function makeEnv(): AppEnv {
  return {
    ...env,
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    TWITCH_BROADCASTER_ID: "12345",
  } as AppEnv;
}

type RouteHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(routes: Record<string, RouteHandler>) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.href.includes(pattern)) {
        return await handler(url, init);
      }
    }
    throw new Error(`unexpected request: ${url.href}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const tokenResponse = {
  access_token: "token-1",
  expires_in: 5000000,
  token_type: "bearer",
};

const onlineSubscription = {
  id: "sub-1",
  status: "enabled",
  type: "stream.online",
  version: "1",
  condition: { broadcaster_user_id: "12345" },
  transport: { method: "webhook", callback: "https://example.com/" },
  created_at: "2026-08-07T00:00:00Z",
};

beforeEach(async () => {
  await env.STATE.delete("twitch:token");
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAppAccessToken", () => {
  it("fetches a token and caches it in KV", async () => {
    const fetchMock = mockFetch({
      "oauth2/token": async (_url, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          "Content-Type": "application/x-www-form-urlencoded",
        });
        expect(init?.body).toContain("client_id=test-client-id");
        expect(init?.body).toContain("grant_type=client_credentials");
        return jsonResponse(tokenResponse);
      },
    });

    expect(await getAppAccessToken(makeEnv())).toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(env.STATE.get("twitch:token")).resolves.toContain(
      "access_token",
    );
  });

  it("reuses the cached token without fetching again", async () => {
    await env.STATE.put(
      "twitch:token",
      JSON.stringify({
        access_token: "cached-token",
        expires_at: Date.now() + 60 * 60 * 1000,
      }),
    );

    const fetchMock = mockFetch({
      oauth2: async () => {
        throw new Error("should not be called");
      },
    });

    expect(await getAppAccessToken(makeEnv())).toBe("cached-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches when the cached token is expired", async () => {
    await env.STATE.put(
      "twitch:token",
      JSON.stringify({
        access_token: "expired-token",
        expires_at: Date.now() - 1000,
      }),
    );

    const fetchMock = mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
    });
    expect(await getAppAccessToken(makeEnv())).toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws TwitchError on API failure", async () => {
    mockFetch({
      "oauth2/token": async () =>
        jsonResponse({ error: "Unauthorized", message: "invalid client" }, 400),
    });

    await expect(getAppAccessToken(makeEnv())).rejects.toMatchObject({
      name: "TwitchError",
      status: 400,
      message: "invalid client",
    });
  });

  it("throws TwitchError with status when the error body is not JSON", async () => {
    mockFetch({
      "oauth2/token": async () =>
        new Response("<html>Bad Gateway</html>", { status: 502 }),
    });

    await expect(getAppAccessToken(makeEnv())).rejects.toMatchObject({
      name: "TwitchError",
      status: 502,
    });
  });

  it("throws TwitchError when the token response lacks access_token", async () => {
    mockFetch({
      "oauth2/token": async () => jsonResponse({ token_type: "bearer" }),
    });

    await expect(getAppAccessToken(makeEnv())).rejects.toMatchObject({
      name: "TwitchError",
      status: 502,
    });
  });

  it("deduplicates concurrent token requests (single-flight)", async () => {
    const e = makeEnv();
    let resolveToken: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    const fetchMock = mockFetch({
      "oauth2/token": async () => gate,
    });

    const p1 = getAppAccessToken(e);
    const p2 = getAppAccessToken(e);
    resolveToken!(jsonResponse(tokenResponse));

    await expect(p1).resolves.toBe("token-1");
    await expect(p2).resolves.toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchTwitchUserByLogin", () => {
  it("app access tokenでloginを検索してチャネル情報を返す", async () => {
    const fetchMock = mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "helix/users?login=azumagsandbox": async (url, init) => {
        expect(url.searchParams.get("login")).toBe("azumagsandbox");
        expect(init?.headers).toMatchObject({
          "Client-ID": "test-client-id",
          Authorization: "Bearer token-1",
        });
        return jsonResponse({
          data: [
            {
              id: "742412446",
              login: "azumagsandbox",
              display_name: "azumagsandbox",
              profile_image_url: "https://example.com/sandbox.png",
            },
          ],
        });
      },
    });

    await expect(
      fetchTwitchUserByLogin(makeEnv(), "AzumagSandbox"),
    ).resolves.toEqual({
      id: "742412446",
      login: "azumagsandbox",
      displayName: "azumagsandbox",
      profileImageUrl: "https://example.com/sandbox.png",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loginが見つからないとnullを返す", async () => {
    mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "helix/users?login=missing": async () => jsonResponse({ data: [] }),
    });

    await expect(
      fetchTwitchUserByLogin(makeEnv(), "missing"),
    ).resolves.toBeNull();
  });

  it("Twitchのユーザー応答が不正なら502を投げる", async () => {
    mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "helix/users?login=broken": async () =>
        jsonResponse({ data: [{ id: "123" }] }),
    });

    await expect(fetchTwitchUserByLogin(makeEnv(), "broken")).rejects.toMatchObject(
      {
        name: "TwitchError",
        status: 502,
      },
    );
  });
});

describe("createSubscription", () => {
  it("POSTs the subscription with webhook transport and returns the result", async () => {
    const fetchMock = mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "eventsub/subscriptions": async (_url, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          "Client-ID": "test-client-id",
          Authorization: "Bearer token-1",
        });
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          type: "stream.online",
          version: "1",
          condition: { broadcaster_user_id: "12345" },
          transport: {
            method: "webhook",
            callback: "https://example.com/twitch/eventsub",
            secret: "webhook-secret",
          },
        });
        return jsonResponse({ data: [onlineSubscription] });
      },
    });

    const sub = await createSubscription(makeEnv(), {
      type: "stream.online",
      version: "1",
      condition: { broadcaster_user_id: "12345" },
      callback: "https://example.com/twitch/eventsub",
      secret: "webhook-secret",
    });

    expect(sub.id).toBe("sub-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("listSubscriptions", () => {
  it("GETs subscriptions with bearer auth", async () => {
    const fetchMock = mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "eventsub/subscriptions": async (_url, init) => {
        expect(init?.method).toBeUndefined();
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer token-1",
        });
        return jsonResponse({ data: [onlineSubscription] });
      },
    });

    const subs = await listSubscriptions(makeEnv());
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe("sub-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("getStreamState", () => {
  it("returns the stream state when the broadcaster is live", async () => {
    mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "streams?user_id=12345": async (_url, init) => {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer token-1" });
        // Helix Get Streams の実際のレスポンス形状(user_id であって
        // broadcaster_user_id ではない)
        return jsonResponse({
          data: [
            {
              id: "stream-1",
              user_id: "12345",
              user_login: "cool_user",
              user_name: "あずまぐ",
              game_id: "509658",
              game_name: "Music",
              type: "live",
              title: "テスト配信",
              viewer_count: 3,
              started_at: "2026-08-07T00:00:00Z",
              language: "ja",
              thumbnail_url:
                "https://static-cdn.jtvnw.net/previews-ttv/live_user_cool_user-{width}x{height}.jpg",
            },
          ],
        });
      },
    });

    const state = await getStreamState(makeEnv(), "12345");
    expect(state).toEqual({
      id: "stream-1",
      startedAt: "2026-08-07T00:00:00Z",
      title: "テスト配信",
      gameName: "Music",
      userLogin: "cool_user",
      thumbnailUrl:
        "https://static-cdn.jtvnw.net/previews-ttv/live_user_cool_user-{width}x{height}.jpg",
    });
  });

  it("returns null when the broadcaster is offline", async () => {
    mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "streams?user_id=12345": async () => jsonResponse({ data: [] }),
    });

    await expect(getStreamState(makeEnv(), "12345")).resolves.toBeNull();
  });

  it("複数チャネルを一度に問い合わせ、配信中だけを引き当てる", async () => {
    mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "helix/streams?": async () =>
        jsonResponse({
          data: [
            {
              id: "stream-2",
              user_id: "67890",
              user_login: "second_user",
              game_name: "Just Chatting",
              title: "雑談中",
              started_at: "2026-08-07T01:00:00Z",
              thumbnail_url:
                "https://static-cdn.jtvnw.net/previews-ttv/live_user_second_user-{width}x{height}.jpg",
            },
          ],
        }),
    });

    const states = await getStreamStatesBatch(makeEnv(), ["12345", "67890"]);

    expect(states.get("12345")).toBeNull();
    expect(states.get("67890")).toEqual({
      id: "stream-2",
      startedAt: "2026-08-07T01:00:00Z",
      title: "雑談中",
      gameName: "Just Chatting",
      userLogin: "second_user",
      thumbnailUrl:
        "https://static-cdn.jtvnw.net/previews-ttv/live_user_second_user-{width}x{height}.jpg",
    });
  });
});

describe("getChannelInformation", () => {
  it("チャネルに設定中のタイトル・カテゴリを返す", async () => {
    mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "helix/channels?broadcaster_id=12345": async (_url, init) => {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer token-1" });
        return jsonResponse({
          data: [
            {
              broadcaster_id: "12345",
              broadcaster_login: "cool_user",
              game_name: "Just Chatting",
              title: "週末の雑談配信",
            },
          ],
        });
      },
    });

    await expect(getChannelInformation(makeEnv(), "12345")).resolves.toEqual({
      title: "週末の雑談配信",
      gameName: "Just Chatting",
    });
  });

  it("チャネルが見つからなければ null", async () => {
    mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "helix/channels?broadcaster_id=12345": async () =>
        jsonResponse({ data: [] }),
    });

    await expect(getChannelInformation(makeEnv(), "12345")).resolves.toBeNull();
  });
});

describe("deleteSubscription", () => {
  it("DELETEs the subscription by id", async () => {
    const fetchMock = mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "eventsub/subscriptions?id=sub-1": async (_url, init) => {
        expect(init?.method).toBe("DELETE");
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer token-1",
        });
        return new Response(null, { status: 204 });
      },
    });

    await expect(deleteSubscription(makeEnv(), "sub-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates Twitch errors", async () => {
    mockFetch({
      "oauth2/token": async () => jsonResponse(tokenResponse),
      "eventsub/subscriptions": async () =>
        jsonResponse({ error: "NotFound", message: "subscription not found" }, 404),
    });

    await expect(deleteSubscription(makeEnv(), "missing")).rejects.toBeInstanceOf(
      TwitchError,
    );
  });
});
