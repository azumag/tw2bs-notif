import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/types";
import {
  BlueskyError,
  BSKY_BASE_URL,
  clearLiveStatus,
  createStreamPost,
  getSession,
  setLiveStatus,
} from "../src/lib/bluesky";

function makeEnv(): AppEnv {
  return {
    ...env,
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
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
        if (url.pathname.includes(pattern)) {
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

const sessionResponse = {
  accessJwt: "jwt-1",
  refreshJwt: "refresh-1",
  handle: "test.bsky.social",
  did: "did:plc:test",
};

const statusRecordCid = "bafyrei0000000000000000000000000000000000000000000";

beforeEach(async () => {
  await env.STATE.delete("bsky:session");
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSession", () => {
  it("creates a session and caches it in KV", async () => {
    const fetchMock = mockFetch({
      "com.atproto.server.createSession": async (_url, init) => {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          identifier: "test.bsky.social",
          password: "test-app-password",
        });
        return jsonResponse(sessionResponse);
      },
    });

    const session = await getSession(makeEnv());
    expect(session.did).toBe("did:plc:test");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cached = (await env.STATE.get("bsky:session", "json")) as {
      accessJwt: string;
    } | null;
    expect(cached?.accessJwt).toBe("jwt-1");
  });

  it("reuses the cached session without fetching again", async () => {
    await env.STATE.put(
      "bsky:session",
      JSON.stringify({
        accessJwt: "cached-jwt",
        did: "did:plc:test",
        expires_at: Date.now() + 60 * 60 * 1000,
      }),
    );

    const fetchMock = mockFetch({
      createSession: async () => {
        throw new Error("should not be called");
      },
    });

    const session = await getSession(makeEnv());
    expect(session.accessJwt).toBe("cached-jwt");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches when the cached session is expired", async () => {
    await env.STATE.put(
      "bsky:session",
      JSON.stringify({
        accessJwt: "expired-jwt",
        did: "did:plc:test",
        expires_at: Date.now() - 1000,
      }),
    );

    const fetchMock = mockFetch({
      createSession: async () => jsonResponse(sessionResponse),
    });

    const session = await getSession(makeEnv());
    expect(session.accessJwt).toBe("jwt-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws BlueskyError on auth failure", async () => {
    mockFetch({
      createSession: async () =>
        jsonResponse({ error: "AuthenticationRequired", message: "Invalid identifier or password" }, 401),
    });

    await expect(getSession(makeEnv())).rejects.toMatchObject({
      name: "BlueskyError",
      status: 401,
      error: "AuthenticationRequired",
    });
  });
});

describe("setLiveStatus", () => {
  it("writes the status record with embed external", async () => {
    const fetchMock = mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse({ uri: `at://did:plc:test/app.bsky.actor.status/self`, cid: statusRecordCid, value: {} }),
      "com.atproto.repo.putRecord": async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.repo).toBe("did:plc:test");
        expect(body.collection).toBe("app.bsky.actor.status");
        expect(body.rkey).toBe("self");
        expect(body.swapRecord).toBe(statusRecordCid);
        expect(body.record.$type).toBe("app.bsky.actor.status");
        expect(body.record.status).toBe("app.bsky.actor.status#live");
        expect(body.record.durationMinutes).toBe(720);
        expect(body.record.embed.external.uri).toBe("https://www.twitch.tv/example");
        expect(body.record.embed.external.title).toBe("テスト配信");
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
    });

    await setLiveStatus(makeEnv(), {
      uri: "https://www.twitch.tv/example",
      title: "テスト配信",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on InvalidSwap error", async () => {
    let getRecordCalls = 0;
    const fetchMock = mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () => {
        getRecordCalls++;
        return jsonResponse({ uri: "at://.../self", cid: `cid-${getRecordCalls}`, value: {} });
      },
      "com.atproto.repo.putRecord": async () => {
        if (getRecordCalls === 1) {
          return jsonResponse(
            { error: "InvalidSwap", message: "Attempted to overwrite record with a different CID" },
            409,
          );
        }
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
    });

    await expect(
      setLiveStatus(makeEnv(), { uri: "https://www.twitch.tv/example" }),
    ).resolves.toBeUndefined();
    expect(getRecordCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("succeeds on first-time set when the record does not exist yet", async () => {
    let swapRecords: (string | null)[] = [];
    mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "com.atproto.repo.putRecord": async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        swapRecords.push(body.swapRecord);
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
    });

    await expect(
      setLiveStatus(makeEnv(), { uri: "https://www.twitch.tv/example" }),
    ).resolves.toBeUndefined();
    expect(swapRecords).toEqual([null]);
  });

  it("throws after exceeding the InvalidSwap retry limit", async () => {
    const fetchMock = mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse({ uri: "at://.../self", cid: "cid-1", value: {} }),
      "com.atproto.repo.putRecord": async () =>
        jsonResponse(
          { error: "InvalidSwap", message: "Attempted to overwrite record with a different CID" },
          409,
        ),
    });

    await expect(
      setLiveStatus(makeEnv(), { uri: "https://www.twitch.tv/example" }),
    ).rejects.toMatchObject({ error: "InvalidSwap" });
    expect(fetchMock).toHaveBeenCalledTimes(11); // 1 session + 5 getRecord + 5 putRecord
  });

  it("retries once with a fresh session on 401", async () => {
    let putCalls = 0;
    const fetchMock = mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse({ uri: "at://.../self", cid: statusRecordCid, value: {} }),
      "com.atproto.repo.putRecord": async () => {
        putCalls++;
        if (putCalls === 1) {
          return jsonResponse({ error: "ExpiredToken", message: "jwt expired" }, 401);
        }
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
    });

    await expect(
      setLiveStatus(makeEnv(), { uri: "https://www.twitch.tv/example" }),
    ).resolves.toBeUndefined();
    expect(putCalls).toBe(2);
    const sessionCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("createSession"),
    );
    expect(sessionCalls).toHaveLength(2);
  });

  it("does not recurse when the retry also gets a 401", async () => {
    const fetchMock = mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse({ uri: "at://.../self", cid: statusRecordCid, value: {} }),
      "com.atproto.repo.putRecord": async () =>
        jsonResponse({ error: "ExpiredToken", message: "jwt expired" }, 401),
    });

    await expect(
      setLiveStatus(makeEnv(), { uri: "https://www.twitch.tv/example" }),
    ).rejects.toMatchObject({ status: 401, error: "ExpiredToken" });
    const sessionCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("createSession"),
    );
    expect(sessionCalls).toHaveLength(2);
  });

  it("always includes title and description in the embed (PDS requires title)", async () => {
    let recordBody: Record<string, unknown> | undefined;
    mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "com.atproto.repo.putRecord": async (_url, init) => {
        recordBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
    });

    await setLiveStatus(makeEnv(), { uri: "https://www.twitch.tv/example" });

    const external = (recordBody as { record: { embed: { external: { title: string; description: string } } } }).record.embed.external;
    expect(external.title).toBe("");
    expect(external.description).toBe("");
  });

  it("throws non-InvalidSwap errors immediately", async () => {
    mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.getRecord": async () =>
        jsonResponse({ error: "InternalServerError", message: "boom" }, 500),
    });

    await expect(
      setLiveStatus(makeEnv(), { uri: "https://www.twitch.tv/example" }),
    ).rejects.toBeInstanceOf(BlueskyError);
  });
});

describe("createStreamPost", () => {
  it("creates a feed post with the stream embed", async () => {
    let postedBody: Record<string, unknown> | undefined;
    const fetchMock = mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.createRecord": async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          uri: "at://did:plc:test/app.bsky.feed.post/3abc",
          cid: "post-cid",
        });
      },
    });

    await createStreamPost(makeEnv(), {
      uri: "https://www.twitch.tv/azumagbanjo",
      title: "テスト配信",
    });

    const record = postedBody?.record as {
      $type: string;
      text: string;
      langs: string[];
      embed: { external: { uri: string; title: string; description: string } };
    };
    expect(postedBody?.collection).toBe("app.bsky.feed.post");
    expect(record.$type).toBe("app.bsky.feed.post");
    expect(record.text).toBe("配信開始しました: テスト配信");
    expect(record.langs).toEqual(["ja"]);
    expect(record.embed.external.uri).toBe("https://www.twitch.tv/azumagbanjo");
    expect(record.embed.external.title).toBe("テスト配信");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to empty strings when title is missing", async () => {
    let postedBody: Record<string, unknown> | undefined;
    mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.createRecord": async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://...", cid: "post-cid" });
      },
    });

    await createStreamPost(makeEnv(), { uri: "https://www.twitch.tv/azumagbanjo" });

    const record = postedBody?.record as { text: string; embed: { external: { title: string; description: string } } };
    expect(record.text).toBe("配信開始しました");
    expect(record.embed.external.title).toBe("");
    expect(record.embed.external.description).toBe("");
  });

  it("propagates API errors", async () => {
    mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.createRecord": async () =>
        jsonResponse({ error: "InternalServerError", message: "boom" }, 500),
    });

    await expect(
      createStreamPost(makeEnv(), { uri: "https://www.twitch.tv/azumagbanjo" }),
    ).rejects.toBeInstanceOf(BlueskyError);
  });
});

describe("clearLiveStatus", () => {
  it("deletes the status record", async () => {
    const fetchMock = mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.deleteRecord": async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.repo).toBe("did:plc:test");
        expect(body.collection).toBe("app.bsky.actor.status");
        expect(body.rkey).toBe("self");
        return jsonResponse({ commit: { cid: "x", rev: "1" } });
      },
    });

    await expect(clearLiveStatus(makeEnv())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores RecordNotFound errors", async () => {
    const fetchMock = mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.deleteRecord": async () =>
        jsonResponse({ error: "RecordNotFound", message: "Could not locate record" }, 400),
    });

    await expect(clearLiveStatus(makeEnv())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates other errors", async () => {
    mockFetch({
      "com.atproto.server.createSession": async () => jsonResponse(sessionResponse),
      "com.atproto.repo.deleteRecord": async () =>
        jsonResponse({ error: "InternalServerError", message: "boom" }, 500),
    });

    await expect(clearLiveStatus(makeEnv())).rejects.toBeInstanceOf(BlueskyError);
  });
});
