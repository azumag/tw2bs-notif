import { EVENTSUB_PATH, handleEventSub } from "./lib/eventsub";
import { refreshStreamStatus } from "./lib/stream";
import type { AppEnv } from "./types";
import {
  buildLoginUrl,
  consumeOAuthState,
  exchangeCode,
  fetchOwnTwitchUser,
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
import {
  ensureChannelSubscriptions,
  removeChannelSubscriptions,
} from "./lib/twitch";
import {
  deleteConnection,
  findConnectionByChannel,
  insertConnection,
  listConnections,
} from "./lib/connections";
import { clearLiveStatus } from "./lib/bluesky";
import { logError, logInfo } from "./lib/logger";

const LOGIN_PATH = "/auth/twitch/login";
const CALLBACK_PATH = "/auth/twitch/callback";
const LOGOUT_PATH = "/auth/logout";
const CHANNELS_PATH = "/channels";
const CHANNELS_CONNECT_PATH = "/channels/connect";
const CHANNELS_DISCONNECT_PATH = "/channels/disconnect";
const WEBHOOK_SECRET_KEY = "twitch:webhook_secret";

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
     <p><a href="${CHANNELS_PATH}">チャンネル連携の管理</a></p>
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

async function handleChannels(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  if (!session) {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }
  const connections = await listConnections(env, session.twitchUserId);
  const rows = connections
    .map(
      (c) =>
        `<li>${escapeHtml(c.twitchDisplayName)} (@${escapeHtml(c.twitchLogin)})
         <form method="post" action="${CHANNELS_DISCONNECT_PATH}" style="display:inline">
           <input type="hidden" name="csrf" value="${session.csrf}">
           <input type="hidden" name="connection_id" value="${c.id}">
           <button type="submit">解除</button>
         </form></li>`,
    )
    .join("");
  return htmlPage(
    "orbsky - チャンネル連携",
    `<h1>チャンネル連携</h1>
     <p>ログイン中: ${escapeHtml(session.twitchUserId)}</p>
     <p><a href="/">← 戻る</a></p>
     <h2>連携済みチャンネル</h2>
     <ul>${rows || "<li>(なし)</li>"}</ul>
     <h2>チャンネルを連携</h2>
     <form method="post" action="${CHANNELS_CONNECT_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button type="submit">自分のチャンネルを連携する</button>
     </form>`,
  );
}

async function handleConnectChannel(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  if (!session || csrf !== session.csrf) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }

  try {
    const secret = await env.STATE.get(WEBHOOK_SECRET_KEY);
    if (!secret) {
      return htmlPage(
        "エラー",
        `<p>webhook secret が設定されていません。管理者に連絡してください。</p>
         <p><a href="${CHANNELS_PATH}">戻る</a></p>`,
      );
    }
    const user = await fetchOwnTwitchUser(env, session.twitchUserId);
    const existing = await findConnectionByChannel(env, user.id, user.id);
    if (!existing) {
      await insertConnection(env, session.twitchUserId, {
        id: user.id,
        login: user.login,
        displayName: user.displayName,
      });
    }
    await ensureChannelSubscriptions(
      env,
      user.id,
      env.EVENTSUB_CALLBACK_URL,
      secret,
    );
    logInfo("channels", "connected channel", { channelId: user.id });
    return new Response(null, { status: 302, headers: { Location: CHANNELS_PATH } });
  } catch (err) {
    logError("channels", "connect failed", err);
    return htmlPage(
      "エラー",
      `<p>連携に失敗しました: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>
       <p><a href="${CHANNELS_PATH}">戻る</a></p>`,
    );
  }
}

async function handleDisconnectChannel(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  const connectionIdRaw = form?.get("connection_id");
  const connectionId =
    typeof connectionIdRaw === "string" ? Number(connectionIdRaw) : NaN;
  if (!session || csrf !== session.csrf || Number.isNaN(connectionId)) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }

  try {
    const connection = await env.DB.prepare(
      `SELECT twitch_channel_id AS twitchChannelId
       FROM connections WHERE id = ? AND user_id = ?`,
    )
      .bind(connectionId, session.twitchUserId)
      .first<{ twitchChannelId: string }>();

    const deleted = await deleteConnection(env, session.twitchUserId, connectionId);
    if (deleted && connection) {
      // EventSub 購読を削除(失敗時はログに残す。購読⇔connections の整合チェックは #15 で対応)
      await removeChannelSubscriptions(env, connection.twitchChannelId).catch(
        (err) => {
          logError("channels", "removeChannelSubscriptions failed", err);
        },
      );
      // 配信中なら Bluesky ステータスを解除する(stale record の掃除は cron の自己修復も行う)
      await clearLiveStatus(env).catch((err) => {
        logError("channels", "clearLiveStatus failed", err);
      });
      logInfo("channels", "disconnected channel", { connectionId });
    }
    return new Response(null, { status: 302, headers: { Location: CHANNELS_PATH } });
  } catch (err) {
    logError("channels", "disconnect failed", err);
    return htmlPage(
      "エラー",
      `<p>解除に失敗しました: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>
       <p><a href="${CHANNELS_PATH}">戻る</a></p>`,
    );
  }
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
    if (url.pathname === CHANNELS_PATH && request.method === "GET") {
      return handleChannels(request, env);
    }
    if (url.pathname === CHANNELS_CONNECT_PATH && request.method === "POST") {
      return handleConnectChannel(request, env);
    }
    if (url.pathname === CHANNELS_DISCONNECT_PATH && request.method === "POST") {
      return handleDisconnectChannel(request, env);
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
