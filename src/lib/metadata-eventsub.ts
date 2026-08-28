import type { AppEnv } from "../types";
import { EVENTSUB_PATH, WEBHOOK_SECRET_KEY, verifyMessageSignature } from "./eventsub";
import { BSKY_JWKS_PATH, getBskyPublicJwks } from "./bsky-oauth";
import { logError } from "./logger";
import { CHANNEL_UPDATE, type ChannelUpdateQueueMessage } from "./metadata-types";

const MAX_TIMESTAMP_AGE_MS = 10 * 60 * 1000;

export async function handleChannelUpdateEventSub(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== EVENTSUB_PATH) return null;

  // confidential OAuth client の公開鍵。EventSub は POST のため、GET のみを
  // ここで処理しても Twitch webhook と競合しない。
  if (
    request.method === "GET" &&
    `${url.pathname}${url.search}` === BSKY_JWKS_PATH
  ) {
    try {
      return new Response(JSON.stringify(await getBskyPublicJwks(env)), {
        status: 200,
        headers: {
          "Content-Type": "application/jwk-set+json; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch (err) {
      logError("bsky", "jwks response failed", err);
      return new Response("JWKS unavailable", { status: 500 });
    }
  }

  if (request.method !== "POST") return null;
  const rawBody = await request.clone().text();
  let payload: { subscription?: { type?: string }; event?: Record<string, unknown> };
  try { payload = JSON.parse(rawBody) as typeof payload; } catch { return null; }
  if (payload.subscription?.type !== CHANNEL_UPDATE) return null;
  if (request.headers.get("Twitch-Eventsub-Message-Type") !== "notification") return null;

  const secret = await env.STATE.get(WEBHOOK_SECRET_KEY);
  if (!secret) return new Response("webhook secret not configured", { status: 500 });
  const messageId = request.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = request.headers.get("Twitch-Eventsub-Message-Signature");
  if (!(await verifyMessageSignature(secret, messageId, timestamp, rawBody, signature))) {
    return new Response("invalid signature", { status: 401 });
  }
  const ageMs = Date.now() - Date.parse(timestamp);
  if (!timestamp || Number.isNaN(ageMs) || ageMs > MAX_TIMESTAMP_AGE_MS) {
    return new Response("stale timestamp", { status: 401 });
  }
  const event = payload.event;
  if (!event || typeof event.broadcaster_user_id !== "string" || typeof event.title !== "string" || typeof event.category_name !== "string") {
    return new Response("invalid payload", { status: 400 });
  }
  const message: ChannelUpdateQueueMessage = {
    type: CHANNEL_UPDATE,
    broadcasterUserId: event.broadcaster_user_id,
    broadcasterUserLogin: typeof event.broadcaster_user_login === "string" ? event.broadcaster_user_login : undefined,
    title: event.title,
    category: event.category_name,
  };
  ctx.waitUntil(env.EVENTS.send(message).catch((err) => logError("eventsub", "queue send failed", err)));
  return new Response(null, { status: 202 });
}
