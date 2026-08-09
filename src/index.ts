import { EVENTSUB_PATH, handleEventSub } from "./lib/eventsub";
import { processStreamEvent, refreshStreamStatus } from "./lib/stream";
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
import type { StreamEvent } from "./lib/stream";
import {
  ensureChannelSubscriptions,
  fetchTwitchUserByLogin,
  removeChannelSubscriptions,
} from "./lib/twitch";
import {
  deleteConnection,
  findConnectionByChannel,
  insertConnection,
  listConnections,
  updateConnectionPostingSettings,
} from "./lib/connections";
import { clearLiveStatus, getSessionForUser } from "./lib/bluesky";
import {
  activateCode,
  deactivateEntitlements,
  hasActiveEntitlement,
  listEntitlements,
  SupportCodeError,
} from "./lib/support";
import {
  hasTwitchSub,
  refreshTwitchSubCheck,
  setTwitchSubCheckDisabled,
} from "./lib/sub-check";
import {
  BSKY_CLIENT_METADATA,
  bindBskySessionToUser,
  completeBskyAuthorization,
  createBskyAuthorizeUrl,
  disconnectBsky,
  getBskyDidForUser,
} from "./lib/bsky-oauth";
import { logError, logInfo } from "./lib/logger";
import {
  MAX_POST_TEMPLATE_LENGTH,
  validatePostTemplate,
} from "./lib/post-template";

const LOGIN_PATH = "/auth/twitch/login";
const CALLBACK_PATH = "/auth/twitch/callback";
const LOGOUT_PATH = "/auth/logout";
const CHANNELS_PATH = "/channels";
const CHANNELS_CONNECT_PATH = "/channels/connect";
const CHANNELS_ADD_PATH = "/channels/add";
const CHANNELS_DISCONNECT_PATH = "/channels/disconnect";
const CHANNELS_POSTING_PATH = "/channels/posting";
const SUPPORT_PATH = "/support";
const SUPPORT_ACTIVATE_PATH = "/support/activate";
const SUPPORT_DEACTIVATE_PATH = "/support/deactivate";
const SUB_CHECK_PATH = "/support/check-subscription";
const SUB_DISABLE_PATH = "/support/disable-subscription";
const SUB_ENABLE_PATH = "/support/enable-subscription";
const FANBOX_URL = "https://azumag.fanbox.cc/";
const TWICA_URL = "https://twica.bluemoon.works/plans";
const BSKY_LOGIN_PATH = "/auth/bluesky/login";
const BSKY_CALLBACK_PATH = "/auth/bluesky/callback";
const BSKY_DISCONNECT_PATH = "/auth/bluesky/disconnect";
const BSKY_METADATA_PATH = "/oauth-client-metadata.json";
const SETTINGS_PATH = "/settings";
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

function supportPlanLabel(planType: string): string {
  if (planType === "support") return "サポーター";
  if (planType === "patron") return "パトロン";
  return planType;
}

function normalizeTwitchLogin(input: string): string | null {
  const login = input.trim().replace(/^@/, "").toLowerCase();
  if (!login || login.length > 100 || !/^[a-z0-9_]+$/.test(login)) {
    return null;
  }
  return login;
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
     <p><a href="${SUPPORT_PATH}">特典(サポートコード)</a></p>
     <p><a href="${SETTINGS_PATH}">Bluesky連携・自動ポストの設定</a></p>
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
  const postingSaved =
    new URL(request.url).searchParams.get("posting") === "saved";
  const canUseMultiChannel = await hasActiveEntitlement(
    env,
    session.twitchUserId,
  );
  const rows = connections
    .map((c) => {
      const suffix = String(c.id);
      return `<li id="channel-${suffix}">
         <h3>${escapeHtml(c.twitchDisplayName)} (@${escapeHtml(c.twitchLogin)})</h3>
         <form method="post" action="${CHANNELS_POSTING_PATH}">
           <input type="hidden" name="csrf" value="${session.csrf}">
           <input type="hidden" name="connection_id" value="${c.id}">
           <p><label>
             <input type="checkbox" name="post_on_start" value="1"${c.postOnStart ? " checked" : ""}>
             配信開始時にBlueskyへポストする
           </label></p>
           <p><label for="post_template_${suffix}">ポスト本文のフォーマット</label><br>
             <textarea id="post_template_${suffix}" name="post_template" rows="5" cols="60" maxlength="${MAX_POST_TEMPLATE_LENGTH}" required>${escapeHtml(c.postTemplate)}</textarea>
           </p>
           <p><label>
             <input type="checkbox" name="include_title" value="1"${c.postIncludeTitle ? " checked" : ""}>
             配信タイトルをポスト本文に含める
           </label></p>
           <p><label>
             <input type="checkbox" name="include_category" value="1"${c.postIncludeCategory ? " checked" : ""}>
             カテゴリをポスト本文に含める
           </label></p>
           <p><small>利用できる変数: {title} (配信タイトル)、{category} (カテゴリ)、{channel} (チャンネル名)、{url} (Twitch URL)。タイトルとカテゴリのチェックを外すと、対応する変数は空になります。</small></p>
           <button type="submit">このチャンネルの投稿設定を保存</button>
         </form>
         <form method="post" action="${CHANNELS_DISCONNECT_PATH}">
           <input type="hidden" name="csrf" value="${session.csrf}">
           <input type="hidden" name="connection_id" value="${c.id}">
           <button type="submit">解除</button>
         </form>
         </li>`;
    })
    .join("");
  const multiChannelSettings = canUseMultiChannel
    ? `<p>ご自身が管理している別のTwitchチャンネルのユーザー名を入力してください。</p>
       <form method="post" action="${CHANNELS_ADD_PATH}">
         <input type="hidden" name="csrf" value="${session.csrf}">
         <label for="channel_login">Twitchユーザー名</label>
         <input id="channel_login" type="text" name="channel_login" required placeholder="例: azumagsandbox">
         <button type="submit">チャンネルを追加</button>
       </form>`
    : `<p>サポートコードまたはTwitchサブスク特典を有効化すると、管理している複数のチャンネルを追加できます。</p>
       <p><a href="${SUPPORT_PATH}">特典を有効化する</a></p>`;
  return htmlPage(
    "orbsky - チャンネル連携",
    `<h1>チャンネル連携</h1>
     <p>ログイン中: ${escapeHtml(session.twitchUserId)}</p>
     <p><a href="/">← 戻る</a></p>
     ${postingSaved ? "<p><strong>チャンネルの自動ポスト設定を保存しました。</strong></p>" : ""}
     <h2>連携済みチャンネル</h2>
     <p>自動ポストのON/OFF、本文、配信タイトル・カテゴリの使用をチャンネルごとに設定できます。この機能はすべてのプランで利用できます。</p>
     <ul>${rows || "<li>(なし)</li>"}</ul>
     <h2>チャンネルを連携</h2>
     <form method="post" action="${CHANNELS_CONNECT_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button type="submit">自分のチャンネルを連携する</button>
     </form>
     <h2>マルチチャンネル設定</h2>
     ${multiChannelSettings}`,
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
      // 特典ゲート: 無料は1チャンネルまで、特典(Fanboxコード or Twitchサブスク)で複数可
      const count = await listConnections(env, session.twitchUserId);
      if (count.length >= 1 && !(await hasActiveEntitlement(env, session.twitchUserId))) {
        return htmlPage(
          "特典",
          `<p>連携できるチャンネルは無料プランでは1つまでです。サポートコードまたはTwitchサブスクで複数連携が解放されます。</p>
           <p><a href="${SUPPORT_PATH}">特典ページへ</a></p>`,
        );
      }
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

async function handleAddChannel(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  const loginRaw = form?.get("channel_login");
  const login =
    typeof loginRaw === "string" ? normalizeTwitchLogin(loginRaw) : null;
  if (!session || csrf !== session.csrf) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }
  if (!login) {
    return htmlPage(
      "エラー",
      `<p>Twitchユーザー名を正しく入力してください。</p>
       <p><a href="${CHANNELS_PATH}">戻る</a></p>`,
    );
  }
  if (!(await hasActiveEntitlement(env, session.twitchUserId))) {
    return htmlPage(
      "特典",
      `<p>マルチチャンネル設定には、サポートコードまたはTwitchサブスク特典の有効化が必要です。</p>
       <p><a href="${SUPPORT_PATH}">特典ページへ</a></p>`,
    );
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
    const channel = await fetchTwitchUserByLogin(env, login);
    if (!channel) {
      return htmlPage(
        "エラー",
        `<p>Twitchチャンネルが見つかりません。ユーザー名を確認してください。</p>
         <p><a href="${CHANNELS_PATH}">戻る</a></p>`,
      );
    }
    const existing = await findConnectionByChannel(
      env,
      session.twitchUserId,
      channel.id,
    );
    if (!existing) {
      await insertConnection(env, session.twitchUserId, channel);
    }
    await ensureChannelSubscriptions(
      env,
      channel.id,
      env.EVENTSUB_CALLBACK_URL,
      secret,
    );
    logInfo("channels", "added multi-channel connection", {
      userId: session.twitchUserId,
      channelId: channel.id,
    });
    return new Response(null, {
      status: 302,
      headers: { Location: CHANNELS_PATH },
    });
  } catch (err) {
    logError("channels", "add multi-channel connection failed", err, {
      userId: session.twitchUserId,
    });
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
      const sessionForBsky = await getSessionForUser(env, session.twitchUserId);
      if (sessionForBsky) {
        await clearLiveStatus(sessionForBsky).catch((err) => {
          logError("channels", "clearLiveStatus failed", err);
        });
      }
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

async function handleSupport(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  if (!session) {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }
  const licenses = await listEntitlements(env, session.twitchUserId);
  const rows = licenses
    .map(
      (l) =>
        `<li>${escapeHtml(supportPlanLabel(l.planType))}${l.fanboxId ? ` (fanbox: ${escapeHtml(l.fanboxId)})` : ""}
         <small>(${escapeHtml(l.activatedAt)})</small></li>`,
    )
    .join("");

  // Twitch サブスク状態(1時間キャッシュ)
  const userRow = await env.DB.prepare(
    `SELECT twitch_sub_check_disabled AS disabled, twitch_has_sub AS hasSub
     FROM users WHERE twitch_user_id = ?`,
  )
    .bind(session.twitchUserId)
    .first<{ disabled: number; hasSub: number | null }>();
  const subDisabled = !!userRow?.disabled;

  let subStatus: string;
  let subActions: string;
  if (subDisabled) {
    subStatus = "無効中";
    subActions = `<form method="post" action="${SUB_ENABLE_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button type="submit">サブスク判定を再有効化</button>
     </form>`;
  } else {
    subStatus = await hasTwitchSub(env, session.twitchUserId)
      .then((hasSub) => (hasSub ? "サブスク中 ✓" : "サブスクなし"))
      .catch(() => "確認できません");
    subActions = `<form method="post" action="${SUB_CHECK_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button type="submit">サブスク状態を再確認</button>
     </form>
     <form method="post" action="${SUB_DISABLE_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button type="submit">サブスク判定を無効にする</button>
     </form>`;
  }

  return htmlPage(
    "orbsky - 特典",
    `<h1>特典(サポートコード / Twitchサブスク)</h1>
     <p><a href="/">← 戻る</a></p>
     <h2>サポートコードでできること</h2>
     <p>無料利用では連携できるTwitchチャンネルは1つです。サポートコードを有効化すると、2つ目以降も追加して複数のTwitchチャンネルを連携できます。</p>
     <p>連携した各チャンネルの配信開始・終了を検知し、同じBlueskyアカウントの配信ステータスと自動投稿へ反映できます。</p>
     <ul>
       <li><strong>サポーター:</strong> 複数チャンネル連携を利用できます。</li>
       <li><strong>パトロン:</strong> 複数チャンネル連携を利用できます。orbskyでは現在、サポーターと同じ特典内容です。</li>
     </ul>
     <h2>FANBOXでサポートコードを受け取る</h2>
     <p>azumagのFANBOXで支援してくださった方へ、サポートコードをお届けしています。</p>
     <p>支援後、FANBOXのメッセージまたは支援者向け投稿でコードを確認し、下のフォームへ入力してください。</p>
     <p><a href="${FANBOX_URL}" target="_blank" rel="noopener noreferrer">azumagのFANBOXを見る</a></p>
     <p>サポートコードは、別サービス <a href="${TWICA_URL}" target="_blank" rel="noopener noreferrer">twica</a> と同一のものをご利用いただけます。</p>
     <h2>現在の特典</h2>
     <ul>${rows || "<li>(なし)</li>"}</ul>
     <h2>Twitchサブスク(azumagbanjo)</h2>
     <p>状態: ${escapeHtml(subStatus)}</p>
     ${subActions}
     <h2>サポートコードを入力</h2>
     <form method="post" action="${SUPPORT_ACTIVATE_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <input type="text" name="code" required placeholder="コード">
       <button type="submit">有効化</button>
     </form>
     <form method="post" action="${SUPPORT_DEACTIVATE_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button type="submit">コード特典を解除</button>
     </form>`,
  );
}

async function handleSupportActivate(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  const codeRaw = form?.get("code");
  const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
  if (!session || csrf !== session.csrf || !code) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }

  try {
    const license = await activateCode(env, session.twitchUserId, code);
    logInfo("support", "code activated", {
      userId: session.twitchUserId,
      planType: license.planType,
    });
    return htmlPage(
      "特典",
      `<p>有効化しました(プラン: ${escapeHtml(supportPlanLabel(license.planType))})</p>
       <p><a href="${CHANNELS_PATH}">マルチチャンネル設定へ進む</a></p>
       <p><a href="${SUPPORT_PATH}">戻る</a></p>`,
    );
  } catch (err) {
    const message =
      err instanceof SupportCodeError ? err.message : "有効化に失敗しました";
    if (err instanceof SupportCodeError) {
      logInfo("support", "activate rejected", {
        userId: session.twitchUserId,
        reason: err.message,
      });
    } else {
      logError("support", "activate failed", err, {
        userId: session.twitchUserId,
      });
    }
    return htmlPage(
      "特典",
      `<p>${escapeHtml(message)}</p><p><a href="${SUPPORT_PATH}">戻る</a></p>`,
    );
  }
}

async function handleSupportDeactivate(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  if (!session || csrf !== session.csrf) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }
  await deactivateEntitlements(env, session.twitchUserId);
  logInfo("support", "entitlements deactivated", {
    userId: session.twitchUserId,
  });
  return new Response(null, { status: 302, headers: { Location: SUPPORT_PATH } });
}

async function handleSubCheck(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  if (!session || csrf !== session.csrf) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }

  const result = await refreshTwitchSubCheck(env, session.twitchUserId);
  if (result === null) {
    return htmlPage(
      "特典",
      `<p>確認に失敗しました。再ログインが必要な場合があります。</p>
       <p><a href="${SUPPORT_PATH}">戻る</a></p>`,
    );
  }
  return htmlPage(
    "特典",
    `<p>${result ? "サブスク中です ✓" : "サブスクは見つかりませんでした"}</p>
     <p><a href="${SUPPORT_PATH}">戻る</a></p>`,
  );
}

async function handleSubDisable(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  if (!session || csrf !== session.csrf) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }
  await setTwitchSubCheckDisabled(env, session.twitchUserId, true);
  logInfo("support", "sub check disabled", { userId: session.twitchUserId });
  return new Response(null, { status: 302, headers: { Location: SUPPORT_PATH } });
}

async function handleSubEnable(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  if (!session || csrf !== session.csrf) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }
  await setTwitchSubCheckDisabled(env, session.twitchUserId, false);
  logInfo("support", "sub check enabled", { userId: session.twitchUserId });
  return new Response(null, { status: 302, headers: { Location: SUPPORT_PATH } });
}

async function handleBskyLogin(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  if (!session) {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }
  try {
    // ハンドル入力なし: Bluesky 側の認可画面でログイン・アカウント選択を行う
    const authUrl = await createBskyAuthorizeUrl(env);
    logInfo("bsky", "oauth started", { userId: session.twitchUserId });
    return new Response(null, { status: 302, headers: { Location: authUrl.toString() } });
  } catch (err) {
    logError("bsky", "authorize failed", err, { userId: session.twitchUserId });
    return htmlPage(
      "エラー",
      "<p>認可の開始に失敗しました。時間をおいてもう一度お試しください。</p>",
    );
  }
}

async function handleBskyCallback(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  if (!session) {
    return htmlPage("エラー", "<p>ログインが必要です。</p>");
  }
  try {
    const { did } = await completeBskyAuthorization(env, new URL(request.url).searchParams);
    await bindBskySessionToUser(env, session.twitchUserId, did);
    logInfo("bsky", "oauth completed", { userId: session.twitchUserId, did });
    return new Response(null, { status: 302, headers: { Location: SETTINGS_PATH } });
  } catch (err) {
    logError("bsky", "oauth callback failed", err, { userId: session.twitchUserId });
    return htmlPage(
      "エラー",
      "<p>Bluesky連携に失敗しました。もう一度お試しください。</p>",
    );
  }
}

async function handleBskyDisconnect(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  if (!session || csrf !== session.csrf) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }
  await disconnectBsky(env, session.twitchUserId);
  logInfo("bsky", "disconnected", { userId: session.twitchUserId });
  return new Response(null, { status: 302, headers: { Location: SETTINGS_PATH } });
}

async function handleChannelPostingSettings(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  if (!session || csrf !== session.csrf) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }
  const connectionIdRaw = form?.get("connection_id");
  const connectionId =
    typeof connectionIdRaw === "string" ? Number(connectionIdRaw) : NaN;
  const postTemplateRaw = form?.get("post_template");
  const postTemplate =
    typeof postTemplateRaw === "string" ? postTemplateRaw.trim() : "";
  if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
    return htmlPage("エラー", "<p>無効なリクエストです。</p>");
  }
  const templateError = validatePostTemplate(postTemplate);
  if (templateError) {
    return htmlPage(
      "エラー",
      `<p>${escapeHtml(templateError)}</p><p><a href="${CHANNELS_PATH}#channel-${connectionId}">戻る</a></p>`,
    );
  }
  try {
    const updated = await updateConnectionPostingSettings(
      env,
      session.twitchUserId,
      connectionId,
      {
        postOnStart: form?.get("post_on_start") === "1",
        postTemplate,
        postIncludeTitle: form?.get("include_title") === "1",
        postIncludeCategory: form?.get("include_category") === "1",
      },
    );
    if (!updated) {
      return htmlPage(
        "エラー",
        "<p>チャンネル設定を保存できませんでした。連携状態を確認してください。</p>",
      );
    }
    logInfo("settings", "updated channel posting preference", {
      userId: session.twitchUserId,
      connectionId,
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${CHANNELS_PATH}?posting=saved#channel-${connectionId}`,
      },
    });
  } catch (err) {
    logError("settings", "channel posting preference update failed", err, {
      userId: session.twitchUserId,
      connectionId,
    });
    return htmlPage(
      "エラー",
      `<p>設定の保存に失敗しました。</p>
       <p><a href="${CHANNELS_PATH}#channel-${connectionId}">戻る</a></p>`,
    );
  }
}

async function handleSettings(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  if (!session) {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }
  const did = await getBskyDidForUser(env, session.twitchUserId);
  const body = did
    ? `<h2>Bluesky連携</h2>
       <p>連携中: ${escapeHtml(did)}</p>
       <form method="post" action="${BSKY_DISCONNECT_PATH}">
         <input type="hidden" name="csrf" value="${session.csrf}">
         <button type="submit">連携を解除</button>
       </form>`
    : `<h2>Bluesky連携</h2>
       <p>未連携です。配信ステータスを反映するには Bluesky アカウントと連携してください。</p>
       <p><a href="${BSKY_LOGIN_PATH}"><button type="button">Blueskyと連携</button></a></p>
       <p><small>連携画面で Bluesky へのログインまたはアカウント選択ができます。</small></p>`;
  return htmlPage(
    "orbsky - 設定",
    `<h1>設定</h1>
     <p><a href="/">← 戻る</a></p>
     ${body}
     <h2>配信開始時の自動ポスト</h2>
     <p>自動ポストのON/OFFと本文は、連携しているTwitchチャンネルごとに設定できます。配信中バッジは自動ポスト設定に関係なく反映されます。</p>
     <p><a href="${CHANNELS_PATH}">チャンネル別の自動ポスト設定を開く</a></p>
     <p><small>この設定はすべてのプランで利用できます。</small></p>`,
  );
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
    if (url.pathname === CHANNELS_ADD_PATH && request.method === "POST") {
      return handleAddChannel(request, env);
    }
    if (url.pathname === CHANNELS_DISCONNECT_PATH && request.method === "POST") {
      return handleDisconnectChannel(request, env);
    }
    if (url.pathname === CHANNELS_POSTING_PATH && request.method === "POST") {
      return handleChannelPostingSettings(request, env);
    }
    if (url.pathname === SUPPORT_PATH && request.method === "GET") {
      return handleSupport(request, env);
    }
    if (url.pathname === SUPPORT_ACTIVATE_PATH && request.method === "POST") {
      return handleSupportActivate(request, env);
    }
    if (url.pathname === SUPPORT_DEACTIVATE_PATH && request.method === "POST") {
      return handleSupportDeactivate(request, env);
    }
    if (url.pathname === SUB_CHECK_PATH && request.method === "POST") {
      return handleSubCheck(request, env);
    }
    if (url.pathname === SUB_DISABLE_PATH && request.method === "POST") {
      return handleSubDisable(request, env);
    }
    if (url.pathname === SUB_ENABLE_PATH && request.method === "POST") {
      return handleSubEnable(request, env);
    }
    if (url.pathname === BSKY_METADATA_PATH && request.method === "GET") {
      // Bluesky OAuth クライアントメタデータ(認可サーバーが参照する)
      return new Response(JSON.stringify(BSKY_CLIENT_METADATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === BSKY_LOGIN_PATH && request.method === "GET") {
      return handleBskyLogin(request, env);
    }
    if (url.pathname === BSKY_CALLBACK_PATH && request.method === "GET") {
      return handleBskyCallback(request, env);
    }
    if (url.pathname === BSKY_DISCONNECT_PATH && request.method === "POST") {
      return handleBskyDisconnect(request, env);
    }
    if (url.pathname === SETTINGS_PATH && request.method === "GET") {
      return handleSettings(request, env);
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
  async queue(batch: MessageBatch<StreamEvent>, env: AppEnv): Promise<void> {
    for (const message of batch.messages) {
      await processStreamEvent(env, message.body);
    }
  },
} satisfies ExportedHandler<AppEnv, StreamEvent>;
