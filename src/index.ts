import { EVENTSUB_PATH, handleEventSub } from "./lib/eventsub";
import { refreshStreamStatus } from "./lib/stream";
import type { AppEnv } from "./types";
import {
  buildLoginUrl,
  consumeOAuthState,
  exchangeCode,
  fetchTwitchUser,
  upsertUserWithTokens,
} from "./lib/twitch-oauth";
import {
  clearSessionCookieHeader,
  createSession,
  deleteSession,
  getSession,
  sessionCookieHeader,
} from "./lib/session";
import { logError, logInfo } from "./lib/logger";

const LOGIN_PATH = "/auth/twitch/login";
const CALLBACK_PATH = "/auth/twitch/callback";
const LOGOUT_PATH = "/auth/logout";

function htmlPage(title: string, body: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderIndex(
  session: { twitchUserId: string; csrf: string } | null,
): Response {
  if (!session) {
    return htmlPage(
      "orbsky",
      `<h1>orbsky</h1><p><a href="${LOGIN_PATH}">Twitchでログイン</a></p>`,
    );
  }
  return htmlPage(
    "orbsky",
    `<h1>orbsky</h1><p>ログイン中: ${escapeHtml(session.twitchUserId)}</p>
     <form method="post" action="${LOGOUT_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button type="submit">ログアウト</button>
     </form>`,
  );
}

async function handleLogin(env: AppEnv): Promise<Response> {
  const url = await buildLoginUrl(env);
  logInfo("auth", "login started");
  return new Response(null, { status: 302, headers: { Location: url } });
}

async function handleCallback(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!code) {
    logError("auth", "callback without code");
    return htmlPage("エラー", "<p>認可が無効です。もう一度ログインしてください。</p>");
  }
  if (!(await consumeOAuthState(env, state))) {
    logError("auth", "callback with invalid state", undefined, { state });
    return htmlPage("エラー", "<p>認可が無効です。もう一度ログインしてください。</p>");
  }
  try {
    const tokens = await exchangeCode(env, code);
    const user = await fetchTwitchUser(env, tokens.accessToken);
    await upsertUserWithTokens(env, user, tokens);
    const { token } = await createSession(env, user.id);
    const secure = url.protocol === "https:";
    logInfo("auth", "login success", { twitchUserId: user.id });
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": sessionCookieHeader(token, secure),
      },
    });
  } catch (err) {
    logError("auth", "login failed", err);
    return htmlPage(
      "エラー",
      "<p>ログインに失敗しました。時間をおいてもう一度お試しください。</p>",
    );
  }
}

async function handleLogout(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  if (!session || csrf !== session.csrf) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }
  await deleteSession(env, request);
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": clearSessionCookieHeader() },
  });
}

export default {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === EVENTSUB_PATH) {
      return handleEventSub(request, env, ctx);
    }
    if (url.pathname === LOGIN_PATH && request.method === "GET") {
      return handleLogin(env);
    }
    if (url.pathname === CALLBACK_PATH && request.method === "GET") {
      return handleCallback(request, env);
    }
    if (url.pathname === LOGOUT_PATH && request.method === "POST") {
      return handleLogout(request, env);
    }
    if (url.pathname === "/" && request.method === "GET") {
      const session = await getSession(env, request);
      return renderIndex(session);
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(
    _controller: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(refreshStreamStatus(env));
  },
} satisfies ExportedHandler<AppEnv>;
