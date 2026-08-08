import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/types";
import {
  EVENTSUB_PATH,
  WEBHOOK_SECRET_KEY,
  handleEventSub,
} from "../src/lib/eventsub";

const streamModule = await import("../src/lib/stream");
vi.mock("../src/lib/stream", () => ({
  processStreamEvent: vi.fn(async () => {}),
}));

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

const SECRET = "webhook-secret";
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

async function signedPost(
  body: unknown,
  opts?: {
    secret?: string;
    signature?: string | null;
    messageType?: string;
    messageId?: string;
    timestamp?: string;
  },
): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const secret = opts?.secret ?? SECRET;
  const messageId = opts?.messageId ?? MESSAGE_ID;
  const timestamp = opts?.timestamp ?? freshTimestamp();
  const signature =
    opts?.signature !== undefined
      ? opts.signature
      : `sha256=${await hmacHex(secret, messageId + timestamp + rawBody)}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Twitch-Eventsub-Message-Type": opts?.messageType ?? "notification",
    "Twitch-Eventsub-Message-Id": messageId,
    "Twitch-Eventsub-Message-Timestamp": timestamp,
  };
  if (signature !== null) {
    headers["Twitch-Eventsub-Message-Signature"] = signature;
  }
  return new Request(`https://example.com${EVENTSUB_PATH}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

beforeEach(async () => {
  await env.STATE.put(WEBHOOK_SECRET_KEY, SECRET);
  vi.mocked(streamModule.processStreamEvent).mockReset();
  vi.mocked(streamModule.processStreamEvent).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleEventSub", () => {
  it("rejects non-POST requests", async () => {
    const res = await handleEventSub(
      new Request(`https://example.com${EVENTSUB_PATH}`, { method: "GET" }),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(405);
  });

  it("returns 500 when the webhook secret is not configured", async () => {
    await env.STATE.delete(WEBHOOK_SECRET_KEY);
    const res = await handleEventSub(
      await signedPost({ challenge: "abc" }, { messageType: "webhook_callback_verification" }),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(500);
  });

  it("rejects requests with an invalid signature", async () => {
    const res = await handleEventSub(
      await signedPost(
        { challenge: "abc" },
        { messageType: "webhook_callback_verification", signature: "sha256=deadbeef" },
      ),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects requests without a signature header", async () => {
    const res = await handleEventSub(
      await signedPost(
        { challenge: "abc" },
        { messageType: "webhook_callback_verification", signature: null },
      ),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects requests with a stale timestamp", async () => {
    const res = await handleEventSub(
      await signedPost(
        { challenge: "abc" },
        {
          messageType: "webhook_callback_verification",
          timestamp: "2026-08-06T00:00:00Z",
        },
      ),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it("rejects signatures with a different prefix", async () => {
    const rawBody = JSON.stringify({ challenge: "abc" });
    const ts = freshTimestamp();
    const sig = await hmacHex(SECRET, MESSAGE_ID + ts + rawBody);
    const res = await handleEventSub(
      await signedPost(
        { challenge: "abc" },
        { messageType: "webhook_callback_verification", signature: `sha1=${sig}`, timestamp: ts },
      ),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it("responds to the subscription challenge with the challenge string", async () => {
    const res = await handleEventSub(
      await signedPost(
        {
          challenge: "challenge-123",
          subscription: { id: "s1", type: "stream.online", version: "1", status: "enabled", created_at: "" },
        },
        { messageType: "webhook_callback_verification" },
      ),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toBe("challenge-123");
  });

  it("returns 204 for revocations", async () => {
    const res = await handleEventSub(
      await signedPost(
        {
          subscription: { id: "s1", type: "stream.online", version: "1", status: "authorization_revoked", created_at: "" },
        },
        { messageType: "revocation" },
      ),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(204);
  });

  it("forwards stream.online events to processStreamEvent and returns 202", async () => {
    const ctx = createExecutionContext();
    const res = await handleEventSub(
      await signedPost({
        subscription: { id: "s1", type: "stream.online", version: "1", status: "enabled", created_at: "" },
        event: {
          id: "event-1",
          broadcaster_user_id: "12345",
          started_at: "2026-08-07T00:00:00Z",
        },
      }),
      makeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    expect(streamModule.processStreamEvent).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: "event-1",
        type: "stream.online",
        broadcasterUserId: "12345",
        broadcasterUserLogin: undefined,
        startedAt: "2026-08-07T00:00:00Z",
      },
    );
  });

  it("forwards stream.offline events and returns 202", async () => {
    const ctx = createExecutionContext();
    const res = await handleEventSub(
      await signedPost({
        subscription: { id: "s1", type: "stream.offline", version: "1", status: "enabled", created_at: "" },
        event: { broadcaster_user_id: "12345" },
      }),
      makeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    expect(streamModule.processStreamEvent).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(streamModule.processStreamEvent).mock.calls[0][1].type,
    ).toBe("stream.offline");
  });

  it("passes through stream.offline events without an id", async () => {
    const ctx = createExecutionContext();
    const res = await handleEventSub(
      await signedPost({
        subscription: { id: "s1", type: "stream.offline", version: "1", status: "enabled", created_at: "" },
        event: { broadcaster_user_id: "12345" },
      }),
      makeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(202);
    expect(vi.mocked(streamModule.processStreamEvent).mock.calls[0][1]).toEqual({
      id: undefined,
      type: "stream.offline",
      broadcasterUserId: "12345",
      broadcasterUserLogin: undefined,
      startedAt: undefined,
    });
  });

  it("ignores other subscription types", async () => {
    const ctx = createExecutionContext();
    const res = await handleEventSub(
      await signedPost({
        subscription: { id: "s1", type: "user.update", version: "1", status: "enabled", created_at: "" },
        event: { user_id: "12345" },
      }),
      makeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(streamModule.processStreamEvent).not.toHaveBeenCalled();
  });

  it("rejects stream events without an event object", async () => {
    const res = await handleEventSub(
      await signedPost({
        subscription: { id: "s1", type: "stream.online", version: "1", status: "enabled", created_at: "" },
      }),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const rawBody = "{not json";
    const ts = freshTimestamp();
    const signature = `sha256=${await hmacHex(SECRET, MESSAGE_ID + ts + rawBody)}`;
    const res = await handleEventSub(
      new Request(`https://example.com${EVENTSUB_PATH}`, {
        method: "POST",
        headers: {
          "Twitch-Eventsub-Message-Type": "notification",
          "Twitch-Eventsub-Message-Id": MESSAGE_ID,
          "Twitch-Eventsub-Message-Timestamp": ts,
          "Twitch-Eventsub-Message-Signature": signature,
        },
        body: rawBody,
      }),
      makeEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(400);
  });
});
