import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

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

describe("tw2bs-notif worker", () => {
  it("responds with running message on GET /", async () => {
    const response = await exports.default.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tw2bs-notif is running");
  });

  it("can read and write KV values", async () => {
    await env.STATE.put("test-key", "test-value");
    expect(await env.STATE.get("test-key")).toBe("test-value");
  });

  it("routes EventSub notifications through the webhook endpoint", async () => {
    const secret = "integration-secret";
    await env.STATE.put("twitch:webhook_secret", secret);

    const body = JSON.stringify({
      subscription: {
        id: "s1",
        type: "stream.online",
        version: "1",
        status: "enabled",
        created_at: "",
      },
      event: { id: "event-1", broadcaster_user_id: "12345" },
    });
    const messageId = "msg-1";
    const timestamp = new Date().toISOString();
    const signature = `sha256=${await hmacHex(secret, messageId + timestamp + body)}`;

    const response = await exports.default.fetch(
      "https://example.com/twitch/eventsub",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Twitch-Eventsub-Message-Type": "notification",
          "Twitch-Eventsub-Message-Id": messageId,
          "Twitch-Eventsub-Message-Timestamp": timestamp,
          "Twitch-Eventsub-Message-Signature": signature,
        },
        body,
      },
    );
    expect(response.status).toBe(202);
  });
});
