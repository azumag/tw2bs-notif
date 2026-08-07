import type { AppEnv } from "../types";
import { STREAM_OFFLINE, STREAM_ONLINE } from "../types";
import { processStreamEvent, type StreamEvent } from "./stream";

export const EVENTSUB_PATH = "/twitch/eventsub";
export const WEBHOOK_SECRET_KEY = "twitch:webhook_secret";

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

export async function verifyHmac(
  secret: string,
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
    new TextEncoder().encode(body),
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
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!(await verifyHmac(secret, rawBody, signature))) {
    return new Response("invalid signature", { status: 401 });
  }

  let payload: EventSubPayload;
  try {
    payload = JSON.parse(rawBody) as EventSubPayload;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (typeof payload.challenge === "string") {
    // 購読登録時の検証リクエスト: challenge をそのまま返す
    return new Response(payload.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
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
    startedAt:
      typeof event.started_at === "string" ? event.started_at : undefined,
  };

  ctx.waitUntil(processStreamEvent(env, streamEvent));
  return new Response(null, { status: 202 });
}
