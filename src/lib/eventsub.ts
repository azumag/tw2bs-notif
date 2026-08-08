import type { AppEnv } from "../types";
import { STREAM_OFFLINE, STREAM_ONLINE } from "../types";
import type { StreamEvent } from "./stream";
import { logError } from "./logger";

export const EVENTSUB_PATH = "/twitch/eventsub";
export const WEBHOOK_SECRET_KEY = "twitch:webhook_secret";

// Twitch EventSub webhook の現行仕様(2026-08 確認):
// 署名ヘッダは Twitch-Eventsub-Message-Signature、HMAC 対象は
// Message-Id + Message-Timestamp + 生ボディの連結
// https://dev.twitch.tv/docs/eventsub/handling-webhook-events/
const HDR_MESSAGE_ID = "Twitch-Eventsub-Message-Id";
const HDR_MESSAGE_TIMESTAMP = "Twitch-Eventsub-Message-Timestamp";
const HDR_MESSAGE_SIGNATURE = "Twitch-Eventsub-Message-Signature";
const HDR_MESSAGE_TYPE = "Twitch-Eventsub-Message-Type";

const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_REVOCATION = "revocation";

const MAX_TIMESTAMP_AGE_MS = 10 * 60 * 1000;

export interface EventSubPayload {
  subscription?: {
    id: string;
    type: string;
    version: string;
    status: string;
    created_at: string;
  };
  challenge?: string;
  event?: Record<string, unknown>;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyMessageSignature(
  secret: string,
  messageId: string,
  timestamp: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }
  const hex = signature.slice("sha256=".length);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    return false;
  }
  const message = messageId + timestamp + body;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    hexToBytes(hex.toLowerCase()),
    new TextEncoder().encode(message),
  );
}

export async function handleEventSub(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const secret = await env.STATE.get(WEBHOOK_SECRET_KEY);
  if (!secret) {
    return new Response("webhook secret not configured", { status: 500 });
  }

  const rawBody = await request.text();
  const messageId = request.headers.get(HDR_MESSAGE_ID) ?? "";
  const timestamp = request.headers.get(HDR_MESSAGE_TIMESTAMP) ?? "";
  const signature = request.headers.get(HDR_MESSAGE_SIGNATURE);

  if (
    !(await verifyMessageSignature(secret, messageId, timestamp, rawBody, signature))
  ) {
    return new Response("invalid signature", { status: 401 });
  }

  // タイムスタンプの鮮度チェック(10分以上前の再送は拒否)
  if (timestamp) {
    const ageMs = Date.now() - Date.parse(timestamp);
    if (Number.isNaN(ageMs) || ageMs > MAX_TIMESTAMP_AGE_MS) {
      return new Response("stale timestamp", { status: 401 });
    }
  }

  const messageType = request.headers.get(HDR_MESSAGE_TYPE) ?? "";
  let payload: EventSubPayload;
  try {
    payload = JSON.parse(rawBody) as EventSubPayload;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (messageType === MESSAGE_TYPE_VERIFICATION) {
    if (typeof payload.challenge !== "string") {
      return new Response("invalid payload", { status: 400 });
    }
    // 購読登録時の検証: challenge をそのまま返す
    return new Response(payload.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (messageType === MESSAGE_TYPE_REVOCATION) {
    return new Response(null, { status: 204 });
  }

  if (messageType !== MESSAGE_TYPE_NOTIFICATION) {
    return new Response("ignored", { status: 200 });
  }

  const type = payload.subscription?.type;
  if (type !== STREAM_ONLINE && type !== STREAM_OFFLINE) {
    return new Response("ignored", { status: 200 });
  }
  if (!payload.event) {
    return new Response("invalid payload", { status: 400 });
  }

  const event = payload.event;
  // stream.offline には id が存在しないため任意フィールド
  // (dedup キーは #5 で「online=event.id / offline=broadcaster_user_id」と定める)
  const streamEvent: StreamEvent = {
    id: typeof event.id === "string" ? event.id : undefined,
    type,
    broadcasterUserId:
      typeof event.broadcaster_user_id === "string"
        ? event.broadcaster_user_id
        : "",
    broadcasterUserLogin:
      typeof event.broadcaster_user_login === "string"
        ? event.broadcaster_user_login
        : undefined,
    startedAt:
      typeof event.started_at === "string" ? event.started_at : undefined,
  };

  ctx.waitUntil(
    env.EVENTS.send(streamEvent).catch((err) => {
      logError("eventsub", "queue send failed", err);
    }),
  );
  return new Response(null, { status: 202 });
}
