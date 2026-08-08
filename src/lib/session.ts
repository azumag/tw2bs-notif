import type { AppEnv } from "../types";

/**
 * セッション管理(KV ベース)。
 * セッショントークンは HttpOnly クッキーで配布し、実データは KV に保存する。
 */

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30日
const SESSION_COOKIE = "tw2bs_session";
const SESSION_PREFIX = "session:";

export interface SessionData {
  twitchUserId: string;
  /** 状態変更 API 用の CSRF トークン */
  csrf: string;
  expiresAt: number;
}

function sessionKey(token: string): string {
  return `${SESSION_PREFIX}${token}`;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(
  env: AppEnv,
  twitchUserId: string,
): Promise<{ token: string; csrf: string }> {
  const token = randomToken();
  const csrf = randomToken();
  const data: SessionData = {
    twitchUserId,
    csrf,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  await env.STATE.put(sessionKey(token), JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return { token, csrf };
}

export async function getSession(
  env: AppEnv,
  request: Request,
): Promise<SessionData | null> {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  const token = match.slice(SESSION_COOKIE.length + 1);
  const raw = await env.STATE.get(sessionKey(token), "json");
  if (!raw) return null;
  const data = raw as SessionData;
  if (data.expiresAt < Date.now()) {
    await env.STATE.delete(sessionKey(token));
    return null;
  }
  return data;
}

export async function deleteSession(
  env: AppEnv,
  request: Request,
): Promise<void> {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return;
  const match = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return;
  const token = match.slice(SESSION_COOKIE.length + 1);
  await env.STATE.delete(sessionKey(token));
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${
    secure ? "; Secure" : ""
  }`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
