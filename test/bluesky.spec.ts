import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlueskyError,
  clearLiveStatus,
  createStreamPost,
  setLiveStatus,
  statusRecordExists,
  type BskySessionLike,
} from "../src/lib/bluesky";

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

/** フェイクの OAuth セッション。fetchHandler はグローバル fetch モックに委譲する */
function makeSession(): BskySessionLike {
  return {
    did: "did:plc:test",
    fetchHandler: (pathname, init) =>
      fetch(`https://pds.test${pathname}`, init),
  };
}

const statusRecordCid = "bafyrei0000000000000000000000000000000000000000000";

const thumbBlob = {
  $type: "blob",
  ref: { $link: "bafkrei-thumb" },
  mimeType: "image/jpeg",
  size: 15491,
};

const thumbUrl =
  "https://static-cdn.jtvnw.net/previews-ttv/live_user_cool_user-640x360.jpg";

function thumbResponse(): Response {
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    status: 200,
    headers: { "Content-Type": "image/jpeg" },
  });
}

function uploadBlobRoute(): RouteHandler {
  return async (_url, rinit) => {
    expect(rinit?.method).toBe("POST");
    expect(rinit?.body).toBeInstanceOf(ArrayBuffer);
    return jsonResponse({ blob: thumbBlob });
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setLiveStatus", () => {
  it("writes the status record with embed external", async () => {
    const fetchMock = mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse({ uri: "at://.../self", cid: statusRecordCid, value: {} }),
      "pds.test/xrpc/com.atproto.repo.putRecord": async (_url, init) => {
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

    await setLiveStatus(makeSession(), {
      uri: "https://www.twitch.tv/example",
      title: "テスト配信",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("succeeds on first-time set when the record does not exist yet", async () => {
    let swapRecords: (string | null)[] = [];
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "pds.test/xrpc/com.atproto.repo.putRecord": async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        swapRecords.push(body.swapRecord);
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
    });

    await expect(
      setLiveStatus(makeSession(), { uri: "https://www.twitch.tv/example" }),
    ).resolves.toBeUndefined();
    expect(swapRecords).toEqual([null]);
  });

  it("retries on InvalidSwap error", async () => {
    let getRecordCalls = 0;
    const fetchMock = mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () => {
        getRecordCalls++;
        return jsonResponse({ uri: "at://.../self", cid: `cid-${getRecordCalls}`, value: {} });
      },
      "pds.test/xrpc/com.atproto.repo.putRecord": async () => {
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
      setLiveStatus(makeSession(), { uri: "https://www.twitch.tv/example" }),
    ).resolves.toBeUndefined();
    expect(getRecordCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("always includes title and description in the embed (PDS requires title)", async () => {
    let recordBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "pds.test/xrpc/com.atproto.repo.putRecord": async (_url, init) => {
        recordBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
    });

    await setLiveStatus(makeSession(), { uri: "https://www.twitch.tv/example" });

    const external = (recordBody as { record: { embed: { external: { title: string; description: string } } } }).record.embed.external;
    expect(external.title).toBe("");
    expect(external.description).toBe("");
  });

  it("throws non-InvalidSwap errors immediately", async () => {
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse({ error: "InternalServerError", message: "boom" }, 500),
    });

    await expect(
      setLiveStatus(makeSession(), { uri: "https://www.twitch.tv/example" }),
    ).rejects.toBeInstanceOf(BlueskyError);
  });

  it("uploads the thumbnail and includes thumb in the embed", async () => {
    let recordBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "pds.test/xrpc/com.atproto.repo.uploadBlob": uploadBlobRoute(),
      "pds.test/xrpc/com.atproto.repo.putRecord": async (_url, init) => {
        recordBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
      [thumbUrl]: thumbResponse,
    });

    await setLiveStatus(makeSession(), {
      uri: "https://www.twitch.tv/example",
      thumbnailUrl: thumbUrl,
    });

    const external = (recordBody as {
      record: { embed: { external: { thumb: unknown } } };
    }).record.embed.external;
    expect(external.thumb).toEqual(thumbBlob);
  });

  it("uploads the thumbnail only once across InvalidSwap retries", async () => {
    let getRecordCalls = 0;
    let uploadBlobCalls = 0;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () => {
        getRecordCalls++;
        return jsonResponse({ uri: "at://.../self", cid: `cid-${getRecordCalls}`, value: {} });
      },
      "pds.test/xrpc/com.atproto.repo.uploadBlob": async (_url, init) => {
        uploadBlobCalls++;
        expect(init?.body).toBeInstanceOf(ArrayBuffer);
        return jsonResponse({ blob: thumbBlob });
      },
      "pds.test/xrpc/com.atproto.repo.putRecord": async () => {
        if (getRecordCalls === 1) {
          return jsonResponse(
            { error: "InvalidSwap", message: "Conflict" },
            409,
          );
        }
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
      [thumbUrl]: thumbResponse,
    });

    await setLiveStatus(makeSession(), {
      uri: "https://www.twitch.tv/example",
      thumbnailUrl: thumbUrl,
    });

    expect(getRecordCalls).toBe(2);
    expect(uploadBlobCalls).toBe(1);
  });

  it("omits thumb when the thumbnail fetch fails", async () => {
    let recordBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "pds.test/xrpc/com.atproto.repo.putRecord": async (_url, init) => {
        recordBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
      [thumbUrl]: async () => new Response("nope", { status: 404 }),
    });

    await setLiveStatus(makeSession(), {
      uri: "https://www.twitch.tv/example",
      thumbnailUrl: thumbUrl,
    });

    const external = (recordBody as {
      record: { embed: { external: { thumb?: unknown } } };
    }).record.embed.external;
    expect(external.thumb).toBeUndefined();
  });

  it("omits thumb when the blob upload fails", async () => {
    let recordBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "pds.test/xrpc/com.atproto.repo.uploadBlob": async () =>
        jsonResponse({ error: "InternalServerError", message: "boom" }, 500),
      "pds.test/xrpc/com.atproto.repo.putRecord": async (_url, init) => {
        recordBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
      [thumbUrl]: thumbResponse,
    });

    await setLiveStatus(makeSession(), {
      uri: "https://www.twitch.tv/example",
      thumbnailUrl: thumbUrl,
    });

    const external = (recordBody as {
      record: { embed: { external: { thumb?: unknown } } };
    }).record.embed.external;
    expect(external.thumb).toBeUndefined();
  });

  it("omits thumb when the PDS returns a malformed blob", async () => {
    let recordBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
      "pds.test/xrpc/com.atproto.repo.uploadBlob": async () =>
        jsonResponse({
          blob: { $type: "blob", ref: {}, mimeType: "", size: "oops" },
        }),
      "pds.test/xrpc/com.atproto.repo.putRecord": async (_url, init) => {
        recordBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://.../self", cid: "new-cid" });
      },
      [thumbUrl]: thumbResponse,
    });

    await setLiveStatus(makeSession(), {
      uri: "https://www.twitch.tv/example",
      thumbnailUrl: thumbUrl,
    });

    const external = (recordBody as {
      record: { embed: { external: { thumb?: unknown } } };
    }).record.embed.external;
    expect(external.thumb).toBeUndefined();
  });
});

describe("statusRecordExists", () => {
  it("returns true when the record exists", async () => {
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse({ uri: "at://.../self", cid: "cid-1", value: {} }),
    });
    await expect(statusRecordExists(makeSession())).resolves.toBe(true);
  });

  it("returns false when the record does not exist", async () => {
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.getRecord": async () =>
        jsonResponse(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        ),
    });
    await expect(statusRecordExists(makeSession())).resolves.toBe(false);
  });
});

describe("createStreamPost", () => {
  it("creates a feed post with the stream embed", async () => {
    let postedBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.createRecord": async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          uri: "at://did:plc:test/app.bsky.feed.post/3abc",
          cid: "post-cid",
        });
      },
    });

    await createStreamPost(makeSession(), {
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
  });

  it("falls back to empty strings when title is missing", async () => {
    let postedBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.createRecord": async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://...", cid: "post-cid" });
      },
    });

    await createStreamPost(makeSession(), { uri: "https://www.twitch.tv/azumagbanjo" });

    const record = postedBody?.record as {
      text: string;
      facets?: unknown;
      embed: { external: { title: string; description: string } };
    };
    expect(record.text).toBe("配信開始しました");
    expect(record.embed.external.title).toBe("");
    expect(record.embed.external.description).toBe("");
    // URLもタグも無い本文には facets を付けない
    expect(record.facets).toBeUndefined();
  });

  it("本文中のURLとハッシュタグに facets を付ける", async () => {
    let postedBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.createRecord": async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://...", cid: "post-cid" });
      },
    });

    const text = "週末の雑談配信 #twitch\nhttps://www.twitch.tv/azumagbanjo";
    await createStreamPost(makeSession(), {
      uri: "https://www.twitch.tv/azumagbanjo",
      text,
    });

    const record = postedBody?.record as {
      text: string;
      facets: Array<{
        index: { byteStart: number; byteEnd: number };
        features: Array<{ $type: string; uri?: string; tag?: string }>;
      }>;
    };
    expect(record.text).toBe(text);
    expect(record.facets).toHaveLength(2);
    expect(record.facets.map((f) => f.features[0])).toEqual([
      { $type: "app.bsky.richtext.facet#tag", tag: "twitch" },
      {
        $type: "app.bsky.richtext.facet#link",
        uri: "https://www.twitch.tv/azumagbanjo",
      },
    ]);
    // 範囲が本文の該当部分を指している
    const bytes = new TextEncoder().encode(text);
    const decode = (f: { index: { byteStart: number; byteEnd: number } }) =>
      new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd));
    expect(decode(record.facets[0])).toBe("#twitch");
    expect(decode(record.facets[1])).toBe("https://www.twitch.tv/azumagbanjo");
  });

  it("uses a channel-specific custom post body", async () => {
    let postedBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.createRecord": async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://...", cid: "post-cid" });
      },
    });

    await createStreamPost(makeSession(), {
      uri: "https://www.twitch.tv/azumagbanjo",
      title: "テスト配信",
      text: "あずまぐが配信を開始しました！",
    });

    const record = postedBody?.record as { text: string };
    expect(record.text).toBe("あずまぐが配信を開始しました！");
  });

  it("uploads the thumbnail and includes thumb in the post embed", async () => {
    let postedBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.uploadBlob": uploadBlobRoute(),
      "pds.test/xrpc/com.atproto.repo.createRecord": async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://...", cid: "post-cid" });
      },
      [thumbUrl]: thumbResponse,
    });

    await createStreamPost(makeSession(), {
      uri: "https://www.twitch.tv/azumagbanjo",
      title: "テスト配信",
      thumbnailUrl: thumbUrl,
    });

    const external = (postedBody?.record as {
      embed: { external: { thumb: unknown } };
    }).embed.external;
    expect(external.thumb).toEqual(thumbBlob);
  });

  it("omits thumb when the blob upload fails in the post", async () => {
    let postedBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.uploadBlob": async () =>
        jsonResponse({ error: "InternalServerError", message: "boom" }, 500),
      "pds.test/xrpc/com.atproto.repo.createRecord": async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return jsonResponse({ uri: "at://...", cid: "post-cid" });
      },
      [thumbUrl]: thumbResponse,
    });

    await createStreamPost(makeSession(), {
      uri: "https://www.twitch.tv/azumagbanjo",
      thumbnailUrl: thumbUrl,
    });

    const external = (postedBody?.record as {
      embed: { external: { thumb?: unknown } };
    }).embed.external;
    expect(external.thumb).toBeUndefined();
  });

  it("propagates API errors", async () => {
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.createRecord": async () =>
        jsonResponse({ error: "InternalServerError", message: "boom" }, 500),
    });

    await expect(
      createStreamPost(makeSession(), { uri: "https://www.twitch.tv/azumagbanjo" }),
    ).rejects.toBeInstanceOf(BlueskyError);
  });
});

describe("clearLiveStatus", () => {
  it("deletes the status record", async () => {
    let deleteBody: Record<string, unknown> | undefined;
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.deleteRecord": async (_url, init) => {
        deleteBody = JSON.parse(String(init?.body));
        return jsonResponse({ commit: { cid: "x", rev: "1" } });
      },
    });

    await expect(clearLiveStatus(makeSession())).resolves.toBeUndefined();
    expect(deleteBody?.collection).toBe("app.bsky.actor.status");
    expect(deleteBody?.rkey).toBe("self");
  });

  it("ignores RecordNotFound errors", async () => {
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.deleteRecord": async () =>
        jsonResponse({ error: "RecordNotFound", message: "Could not locate record" }, 400),
    });

    await expect(clearLiveStatus(makeSession())).resolves.toBeUndefined();
  });

  it("propagates other errors", async () => {
    mockFetch({
      "pds.test/xrpc/com.atproto.repo.deleteRecord": async () =>
        jsonResponse({ error: "InternalServerError", message: "boom" }, 500),
    });

    await expect(clearLiveStatus(makeSession())).rejects.toBeInstanceOf(BlueskyError);
  });
});
