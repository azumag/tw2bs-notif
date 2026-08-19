import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import type { AppEnv } from "../src/types";

const SECRET = "webhook-secret";
function makeEnv(send: ReturnType<typeof vi.fn>): AppEnv {
  return {
    ...env,
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    TWITCH_BROADCASTER_ID: "12345",
    BSKY_HANDLE: "test.bsky.social",
    BSKY_APP_PASSWORD: "test-app-password",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    TWITCH_OAUTH_REDIRECT_URL: env.TWITCH_OAUTH_REDIRECT_URL,
    EVENTSUB_CALLBACK_URL: env.EVENTSUB_CALLBACK_URL,
    EVENTS: { send } as unknown as Queue<unknown>,
  } as AppEnv;
}
async function signature(messageId: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const result = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(messageId + timestamp + body));
  return `sha256=${[...new Uint8Array(result)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
beforeEach(async () => { await env.STATE.put("twitch:webhook_secret", SECRET); });

describe("channel.update EventSub", () => {
  it("channel.update v2 を正規化してQueueへ送る", async () => {
    const send = vi.fn(async () => {});
    const body = JSON.stringify({
      subscription: { type: "channel.update", version: "2" },
      event: {
        broadcaster_user_id: "12345",
        broadcaster_user_login: "azumagbanjo",
        title: "新タイトル",
        category_name: "Music",
      },
    });
    const id = "msg-1";
    const timestamp = new Date().toISOString();
    const request = new Request("https://example.com/twitch/eventsub", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Twitch-Eventsub-Message-Type": "notification",
        "Twitch-Eventsub-Message-Id": id,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": await signature(id, timestamp, body),
      },
      body,
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, makeEnv(send), ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledWith({
      type: "channel.update",
      broadcasterUserId: "12345",
      broadcasterUserLogin: "azumagbanjo",
      title: "新タイトル",
      category: "Music",
    });
  });
});
