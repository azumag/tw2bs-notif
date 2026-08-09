import { EVENTSUB_PATH, handleEventSub } from "./lib/eventsub";
import { processStreamEvent, refreshStreamStatus } from "./lib/stream";
import type { AppEnv } from "./types";
import {
  buildLoginUrl,
  consumeOAuthState,
  exchangeCode,
  fetchOwnTwitchUser,
  fetchTwitchUser,
  TwitchOAuthError,
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
import { renderHtmlPage, type PageOptions } from "./ui";

const LOGIN_PATH = "/auth/twitch/login";
const CALLBACK_PATH = "/auth/twitch/callback";
const LOGOUT_PATH = "/auth/logout";
const GUIDE_PATH = "/guide";
const PRIVACY_PATH = "/privacy";
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
const TWITCH_PRIVACY_URL = "https://legal.twitch.com/legal/privacy-notice/";
const BSKY_PRIVACY_URL = "https://bsky.social/about/support/privacy-policy";
const CLOUDFLARE_PRIVACY_URL = "https://www.cloudflare.com/privacypolicy/";
const PRIVACY_CONTACT_URL =
  "https://github.com/azumag/tw2bs-notif/issues/new";
const BSKY_LOGIN_PATH = "/auth/bluesky/login";
const BSKY_CALLBACK_PATH = "/auth/bluesky/callback";
const BSKY_DISCONNECT_PATH = "/auth/bluesky/disconnect";
const BSKY_METADATA_PATH = "/oauth-client-metadata.json";
const SETTINGS_PATH = "/settings";
const WEBHOOK_SECRET_KEY = "twitch:webhook_secret";

function htmlPage(
  title: string,
  body: string,
  options: PageOptions = {},
): Response {
  return new Response(
    renderHtmlPage(title, body, options),
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

type SessionLike = { twitchUserId: string; csrf: string } | null;

/**
 * Renders a one-off notice/error page (CSRF failures, gating messages,
 * confirmations) with the same header, footer, and card styling as the
 * rest of the app, instead of a bare unstyled paragraph. Always forwards
 * the caller's session so a signed-in user keeps their navigation even
 * when a single form submission failed.
 */
function renderMessage(params: {
  title: string;
  heading: string;
  tone?: "info" | "success" | "error";
  body: string;
  primary?: { href: string; label: string };
  secondary?: { href: string; label: string };
  session?: SessionLike;
}): Response {
  const tone = params.tone ?? "info";
  const actions = [
    params.primary
      ? `<a class="button" href="${params.primary.href}">${escapeHtml(params.primary.label)}</a>`
      : "",
    params.secondary
      ? `<a class="button button-secondary" href="${params.secondary.href}">${escapeHtml(params.secondary.label)}</a>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return htmlPage(
    params.title,
    `<article class="focused-page message-page">
       <a class="back-link" href="/">トップへ戻る</a>
       <h1>${escapeHtml(params.heading)}</h1>
       <section class="focus-card message-card is-${tone}">
         ${params.body}
         ${actions ? `<div class="action-row">${actions}</div>` : ""}
       </section>
     </article>`,
    { session: params.session ?? null },
  );
}

function renderInvalidRequest(session: SessionLike): Response {
  return renderMessage({
    title: "エラー",
    heading: "無効なリクエストです",
    tone: "error",
    body: "<p>ページを再読み込みしてから、もう一度お試しください。</p>",
    session,
  });
}

function renderReauthRequired(session: SessionLike): Response {
  return renderMessage({
    title: "エラー",
    heading: "再ログインが必要です",
    tone: "error",
    body: "<p>Twitchのトークンが失効しています。再ログインしてください。</p>",
    primary: { href: LOGIN_PATH, label: "もう一度ログインする" },
    session,
  });
}

function renderOperationUnavailable(session: SessionLike): Response {
  return renderMessage({
    title: "エラー",
    heading: "現在この操作を行えません",
    tone: "error",
    body: "<p>しばらくしてからもう一度お試しください。改善しない場合はお問い合わせください。</p>",
    secondary: { href: CHANNELS_PATH, label: "チャンネル連携に戻る" },
    session,
  });
}

function renderIndex(
  session: { twitchUserId: string; csrf: string } | null,
): Response {
  if (!session) {
    return htmlPage(
      "orbsky",
      `<section class="hero">
         <div>
           <span class="hero-kicker">Twitch × Bluesky</span>
           <h1>配信の始まりを、Blueskyへ。</h1>
           <p class="hero-lead">Twitchの配信開始・終了を検知して、Blueskyの配信中ステータスとお知らせ投稿へ自動で反映します。</p>
           <div class="hero-actions">
             <a class="button" href="${LOGIN_PATH}">Twitchでログイン</a>
             <a class="button button-secondary" href="${GUIDE_PATH}">機能概要・使い方を見る</a>
           </div>
         </div>
         <aside class="hero-summary" aria-label="利用開始までの流れ">
           <h2>3ステップで始められます</h2>
           <ol>
             <li>Twitchアカウントでログイン</li>
             <li>投稿先のBlueskyを選択</li>
             <li>チャンネルごとに投稿内容を設定</li>
           </ol>
         </aside>
       </section>`,
      { currentPath: "/" },
    );
  }
  return htmlPage(
    "orbsky",
    `<section class="dashboard">
       <span class="eyebrow">ホーム</span>
       <h1>配信のお知らせ</h1>
       <p>投稿設定やBluesky・特典の連携状態を、ここからまとめて確認できます。</p>
       <div class="dashboard-focus">
         <a class="dashboard-primary" href="${CHANNELS_PATH}">
           <span class="eyebrow">メイン</span>
           <strong>投稿設定を開く</strong>
           <span>自動ポストのON/OFFと本文をチャンネルごとに編集</span>
         </a>
         <div class="dashboard-links" aria-label="その他の設定">
           <a href="${SETTINGS_PATH}"><strong>Bluesky連携</strong><span>投稿先を確認・変更</span></a>
           <a href="${SUPPORT_PATH}"><strong>特典</strong><span>マルチチャンネルを管理</span></a>
           <a href="${GUIDE_PATH}"><strong>使い方</strong><span>設定の流れを確認</span></a>
         </div>
       </div>
       <div class="dashboard-footer">
         <span class="compact-status is-success">Twitchログイン済み</span>
         <form method="post" action="${LOGOUT_PATH}">
           <input type="hidden" name="csrf" value="${session.csrf}">
           <button class="text-button" type="submit">ログアウト</button>
         </form>
       </div>
     </section>`,
    { session, currentPath: "/" },
  );
}

function renderGuide(
  session: { twitchUserId: string; csrf: string } | null,
): Response {
  const startAction = session
    ? `<div class="hero-actions"><a class="button" href="${SETTINGS_PATH}">Bluesky連携を設定する</a>
       <a class="button button-secondary" href="${CHANNELS_PATH}">チャンネル連携・自動ポストを設定する</a></div>`
    : `<div class="hero-actions"><a class="button" href="${LOGIN_PATH}">Twitchでログインして始める</a></div>`;

  return htmlPage(
    "orbsky - 機能概要・使い方",
    `<article class="content-page wide">
     <a class="back-link" href="/">トップへ戻る</a>
     <h1>orbsky の機能概要・使い方</h1>
     <p class="lead">Twitchで配信を始めたときに、Blueskyのプロフィールへ配信中ステータスを表示し、必要に応じてお知らせを自動投稿するサービスです。</p>

     <h2>orbskyでできること</h2>
     <div class="feature-grid">
       <div class="feature-item"><strong>配信中ステータス</strong><span>Twitchの配信開始を検知し、Blueskyへ配信中バッジとリンクを表示します。</span></div>
       <div class="feature-item"><strong>チャンネル別の自動ポスト</strong><span>投稿のON/OFF、本文、配信タイトル、カテゴリをチャンネルごとに設定できます。</span></div>
       <div class="feature-item"><strong>マルチチャンネル</strong><span>特典を有効化すると、複数のTwitchチャンネルを1つのBlueskyへ連携できます。</span></div>
     </div>
     <p>配信終了を検知すると、配信中バッジは自動で解除されます。</p>

     <h2>使い方</h2>
     <ol class="step-list">
       <li>
         <h3>Twitchでログイン</h3>
         <p>Twitchアカウントでorbskyへログインします。自分のチャンネル以外を追加する場合も、最初に管理用のTwitchアカウントでログインしてください。</p>
       </li>
       <li>
         <h3>Blueskyアカウントを連携</h3>
         <p><a href="${SETTINGS_PATH}">設定</a>から「Blueskyと連携」を選び、配信中バッジと自動ポストを反映するBlueskyアカウントを選択します。</p>
       </li>
       <li>
         <h3>Twitchチャンネルを連携</h3>
         <p><a href="${CHANNELS_PATH}">チャンネル連携</a>で「自分のチャンネルを連携する」を選びます。連携後は、ページを開いたままにする必要はありません。</p>
       </li>
       <li>
         <h3>自動ポストを設定</h3>
         <p>連携済みチャンネルごとに、自動ポストのON/OFF、本文フォーマット、配信タイトルとカテゴリを本文へ含めるかを設定して保存します。</p>
       </li>
       <li>
         <h3>配信する</h3>
         <p>通常どおりTwitchで配信を開始します。orbskyが開始・終了を検知してBlueskyへ反映します。</p>
       </li>
     </ol>

     <h2>自動ポスト本文のカスタマイズ</h2>
     <p>本文フォーマットでは、次の変数を好きな位置に配置できます。</p>
     <div class="table-wrap"><table>
       <thead><tr><th>変数</th><th>投稿時に入る内容</th></tr></thead>
       <tbody>
         <tr><td><code>{title}</code></td><td>現在の配信タイトル</td></tr>
         <tr><td><code>{category}</code></td><td>現在のTwitchカテゴリ</td></tr>
         <tr><td><code>{channel}</code></td><td>連携したチャンネル名</td></tr>
         <tr><td><code>{url}</code></td><td>連携したTwitchチャンネルのURL</td></tr>
       </tbody>
     </table></div>
     <p>例:</p>
     <pre><code>🔴 {channel} が配信を始めました
{title}
カテゴリ: {category}
{url}</code></pre>
     <p>「配信タイトルをポスト本文に含める」「カテゴリをポスト本文に含める」のチェックを外すと、対応する変数は空になります。</p>

     <h2>無料利用と特典</h2>
     <div class="table-wrap"><table>
       <thead><tr><th>利用状態</th><th>連携できるTwitchチャンネル</th><th>自動ポスト設定</th></tr></thead>
       <tbody>
         <tr><td>無料</td><td>1チャンネル</td><td>利用可能</td></tr>
         <tr><td>サポート特典</td><td>複数チャンネル</td><td>各チャンネルで利用可能</td></tr>
       </tbody>
     </table></div>
     <p>複数チャンネル連携は、<a href="${SUPPORT_PATH}">特典ページ</a>でFANBOXサポートコードまたはTwitchサブスク特典を有効化すると利用できます。</p>
     <p>サポートコードは、別サービス <a href="${TWICA_URL}" target="_blank" rel="noopener noreferrer">twica</a> と同一のものをご利用いただけます。</p>

     <h2>知っておきたいこと</h2>
     <ul>
       <li>自動ポストをOFFにしても、Blueskyの配信中バッジは反映されます。</li>
       <li>Blueskyが未連携の場合、配信中バッジと自動ポストは反映されません。</li>
       <li>設定はチャンネルごとに保存されるため、複数チャンネルで別々の本文を使えます。</li>
     </ul>

     <h2>orbskyを始める</h2>
     ${startAction}
     </article>`,
    { session, currentPath: GUIDE_PATH },
  );
}

function renderPrivacy(): Response {
  return htmlPage(
    "orbsky - プライバシーポリシー",
    `<article class="content-page">
     <a class="back-link" href="/">トップへ戻る</a>
     <h1>プライバシーポリシー</h1>
     <p class="help-text">最終更新日: 2026年8月9日</p>
     <p class="lead">orbsky（以下「本サービス」）は、Twitchの配信状態をBlueskyへ反映するために必要な範囲で、利用者に関する情報を取り扱います。</p>

     <h2>1. 取得・保存する情報</h2>
     <h3>Twitchに関する情報</h3>
     <ul>
       <li>TwitchユーザーID、ユーザー名、表示名、プロフィール画像URL</li>
       <li>OAuthアクセストークン、リフレッシュトークン、認可スコープ、有効期限</li>
       <li>サブスク特典の判定結果、確認日時、確認機能の設定</li>
       <li>連携したTwitchチャンネルのID、ユーザー名、表示名</li>
     </ul>
     <p>Twitch認証では <code>user:read:email</code> と <code>user:read:subscriptions</code> の権限を要求しますが、本サービスはTwitchアカウントのメールアドレスを保存しません。</p>

     <h3>Blueskyに関する情報</h3>
     <ul>
       <li>BlueskyアカウントのDID</li>
       <li>配信中ステータスと投稿を操作するためのOAuthセッション情報</li>
     </ul>
     <p>本サービスが要求するBlueskyの権限は、配信中ステータスとフィード投稿の作成に限定しています。Blueskyのパスワードは取得・保存しません。</p>

     <h3>設定・特典に関する情報</h3>
     <ul>
       <li>チャンネルごとの自動ポストON/OFF、本文テンプレート、タイトル・カテゴリの使用設定</li>
       <li>サポートコードまたはTwitchサブスクによる特典の有効化状態、プラン、日時</li>
     </ul>
     <p>入力されたサポートコードはハッシュ値で照合し、平文のコードを保存しません。また、コードをFANBOXやtwicaへ送信することはありません。</p>

     <h3>技術情報</h3>
     <ul>
       <li>ログイン維持に必要なセッションクッキー</li>
       <li>OAuth認証に必要な一時的なstate情報</li>
       <li>アクセス日時、処理対象のアカウント・チャンネル識別子、処理結果、エラーなどの運用ログ</li>
     </ul>
     <p>本サービスは広告配信や行動追跡を目的としたCookie、アクセス解析ツールを使用していません。</p>

     <h2>2. 利用目的</h2>
     <ul>
       <li>利用者の認証とログイン状態の維持</li>
       <li>TwitchチャンネルとBlueskyアカウントの連携</li>
       <li>配信開始・終了の検知、配信中ステータスの表示・解除、自動ポスト</li>
       <li>チャンネル別設定、サポート特典、マルチチャンネル機能の提供</li>
       <li>不正利用の防止、障害調査、セキュリティ確保、サービス改善</li>
       <li>法令上必要な対応</li>
     </ul>

     <h2>3. 公開される情報</h2>
     <p>利用者がBluesky連携を有効にすると、配信中ステータス、Twitchチャンネルへのリンク、および設定に応じた自動ポストがBlueskyとAT Protocolネットワーク上で公開されます。投稿本文には、設定に応じてTwitchの配信タイトル、カテゴリ、チャンネル名、URLが含まれます。</p>

     <h2>4. Cookieと保存期間</h2>
     <ul>
       <li>ログインセッションは最長30日で失効します。</li>
       <li>OAuth認証用の一時情報は原則10分で失効します。</li>
       <li>アカウント連携、設定、特典情報は、機能提供・運用に必要な期間または削除依頼へ対応するまで保存します。</li>
       <li>運用ログは、障害調査とセキュリティ確保に必要な期間保存します。</li>
     </ul>
     <p>ログアウトはブラウザのログインセッションのみを削除し、アカウント連携や設定情報は削除しません。</p>

     <h2>5. 外部サービスと国外での取扱い</h2>
     <p>本サービスは、機能提供のために次の外部サービスを利用します。これらの事業者や関連するインフラにより、日本国外で情報が処理・保存される場合があります。</p>
     <ul>
       <li><a href="${TWITCH_PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Twitch</a>: ログイン、アカウント・配信情報、EventSub、サブスク判定</li>
       <li><a href="${BSKY_PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Bluesky / AT Protocol</a>: OAuth認証、配信中ステータス、自動ポスト</li>
       <li><a href="${CLOUDFLARE_PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Cloudflare</a>: ホスティング、データベース、KV、Queue、運用ログ</li>
     </ul>
     <p>各外部サービスでの情報の取扱いは、それぞれのプライバシーポリシーもご確認ください。</p>

     <h2>6. 第三者提供</h2>
     <p>本サービスは、個人情報を販売しません。機能提供に必要な外部サービスへの送信、利用者本人の操作に基づく公開、法令に基づく場合を除き、本人の同意なく第三者へ提供しません。</p>

     <h2>7. 安全管理</h2>
     <p>OAuthトークンとBlueskyセッションは暗号化して保存します。また、HTTPS、HttpOnly・Secure属性を付けたセッションクッキー、CSRF対策、必要最小限のOAuth権限などを用いて情報を保護します。ただし、インターネット上の通信・保存について完全な安全性を保証するものではありません。</p>

     <h2>8. 利用者による管理・削除</h2>
     <ul>
       <li>自動ポストは、チャンネルごとに停止できます。</li>
       <li>チャンネル連携、Bluesky連携、サポート特典は各設定画面から解除できます。</li>
       <li>保存情報の確認、訂正、利用停止、アカウントデータの削除を希望する場合は、下記窓口へご連絡ください。</li>
     </ul>

     <h2>9. 未成年者の利用</h2>
     <p>未成年者は、TwitchおよびBlueskyの利用条件に従い、必要な場合は保護者の同意を得たうえで本サービスを利用してください。</p>

     <h2>10. ポリシーの変更</h2>
     <p>機能、法令、外部サービスの変更などに応じて本ポリシーを改定することがあります。重要な変更がある場合は、本サービス上で分かりやすくお知らせします。</p>

     <h2>11. お問い合わせ</h2>
     <p>運営者: azumag</p>
     <p><a href="${PRIVACY_CONTACT_URL}" target="_blank" rel="noopener noreferrer">GitHubの問い合わせ窓口</a></p>
     <p>問い合わせページは公開されます。OAuthトークン、サポートコード、メールアドレスなどの秘密情報・個人情報は書き込まないでください。</p>
     </article>`,
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
    return renderMessage({
      title: "エラー",
      heading: "ログインを確認できませんでした",
      tone: "error",
      body: "<p>認可が無効です。もう一度ログインしてください。</p>",
      primary: { href: LOGIN_PATH, label: "もう一度ログインする" },
    });
  }
  if (!(await consumeOAuthState(env, state))) {
    logError("auth", "callback with invalid state", undefined, { state });
    return renderMessage({
      title: "エラー",
      heading: "ログインを確認できませんでした",
      tone: "error",
      body: "<p>認可が無効です。もう一度ログインしてください。</p>",
      primary: { href: LOGIN_PATH, label: "もう一度ログインする" },
    });
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
    return renderMessage({
      title: "エラー",
      heading: "ログインに失敗しました",
      tone: "error",
      body: "<p>時間をおいてもう一度お試しください。</p>",
      primary: { href: LOGIN_PATH, label: "もう一度ログインする" },
    });
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
    return renderInvalidRequest(session);
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
  const bskyDid = await getBskyDidForUser(env, session.twitchUserId);
  const tabs = connections
    .map(
      (c, index) => `<button class="channel-tab${index === 0 ? " is-active" : ""}" id="channel-tab-${c.id}" type="button"
        role="tab" aria-selected="${index === 0 ? "true" : "false"}" aria-controls="channel-${c.id}"
        tabindex="${index === 0 ? "0" : "-1"}" data-channel-tab data-channel-target="channel-${c.id}">
        <strong>${escapeHtml(c.twitchDisplayName)}</strong>
        <small>@${escapeHtml(c.twitchLogin)} · 連携済み</small>
      </button>`,
    )
    .join("");
  const panels = connections
    .map((c) => {
      const suffix = String(c.id);
      return `<section class="channel-panel" id="channel-${suffix}" role="tabpanel"
         aria-labelledby="channel-heading-${suffix}" data-channel-panel
         data-channel-login="${escapeHtml(c.twitchLogin)}" data-channel-display="${escapeHtml(c.twitchDisplayName)}">
         <form method="post" action="${CHANNELS_POSTING_PATH}" data-posting-form>
           <input type="hidden" name="csrf" value="${session.csrf}">
           <input type="hidden" name="connection_id" value="${c.id}">
           <div class="panel-header">
             <div>
               <span class="eyebrow">チャンネル</span>
               <h2 id="channel-heading-${suffix}">${escapeHtml(c.twitchDisplayName)} <small>@${escapeHtml(c.twitchLogin)}</small></h2>
             </div>
             <label class="switch-line" for="post_on_start_${suffix}">
               <span>自動ポスト</span>
               <input id="post_on_start_${suffix}" type="checkbox" role="switch" name="post_on_start" value="1"${c.postOnStart ? " checked" : ""}
                 data-post-on-start>
             </label>
           </div>
           <p class="panel-intro">配信開始を検知したときに、Blueskyへ投稿します。</p>
           <div class="field">
             <label for="post_template_${suffix}">投稿文</label>
             <textarea id="post_template_${suffix}" name="post_template" rows="6" maxlength="${MAX_POST_TEMPLATE_LENGTH}"
               data-post-template required>${escapeHtml(c.postTemplate)}</textarea>
           </div>
           <div class="variable-group">
             <strong class="section-label">差し込み項目</strong>
             <div class="variable-buttons">
               <button class="variable-chip" type="button" data-insert-token="{title}">{title}<span>タイトル</span></button>
               <button class="variable-chip" type="button" data-insert-token="{category}">{category}<span>カテゴリ</span></button>
               <button class="variable-chip" type="button" data-insert-token="{channel}">{channel}<span>チャンネル</span></button>
               <button class="variable-chip" type="button" data-insert-token="{url}">{url}<span>URL</span></button>
             </div>
           </div>
           <fieldset class="include-options">
             <legend>投稿に含める情報</legend>
             <label for="include_title_${suffix}">
               <input id="include_title_${suffix}" type="checkbox" name="include_title" value="1"
                 data-include-title${c.postIncludeTitle ? " checked" : ""}>
               配信タイトル
             </label>
             <label for="include_category_${suffix}">
               <input id="include_category_${suffix}" type="checkbox" name="include_category" value="1"
                 data-include-category${c.postIncludeCategory ? " checked" : ""}>
               カテゴリ
             </label>
           </fieldset>
           <div class="action-row">
             <button type="submit">変更を保存</button>
           </div>
           <details class="channel-actions">
             <summary>このチャンネルの連携を管理</summary>
             <p>解除すると、配信状態と自動ポストが反映されなくなります。</p>
             <button class="button-danger" type="submit" formaction="${CHANNELS_DISCONNECT_PATH}" formmethod="post" formnovalidate>連携を解除</button>
           </details>
         </form>
       </section>`;
    })
    .join("");
  const multiChannelSettings = canUseMultiChannel
    ? `<p>ご自身が管理している別のTwitchチャンネルのユーザー名を入力してください。</p>
       <form class="inline-form" method="post" action="${CHANNELS_ADD_PATH}">
         <input type="hidden" name="csrf" value="${session.csrf}">
         <div class="field">
           <label for="channel_login">Twitchユーザー名</label>
           <input id="channel_login" type="text" name="channel_login" required placeholder="例: azumagsandbox">
         </div>
         <button type="submit">チャンネルを追加</button>
       </form>`
    : `<p>サポートコードまたはTwitchサブスク特典を有効化すると、管理している複数のチャンネルを追加できます。</p>
       <p><a class="button button-secondary" href="${SUPPORT_PATH}">特典を有効化する</a></p>`;
  const editor = connections.length
    ? `${connections.length > 1 ? `<span class="section-label">編集するチャンネル</span>
       <div class="channel-tabs" role="tablist" aria-label="連携済みチャンネル">${tabs}</div>` : ""}
       <div class="channel-workspace">
         <div>${panels}</div>
         <aside class="post-preview" aria-live="polite">
           <h2>投稿プレビュー</h2>
           <div class="preview-card">
             <div class="preview-author">
               <strong>orbsky</strong>
               <span data-preview-channel>@channel</span>
             </div>
             <div class="preview-text" data-preview-text>設定した投稿内容がここに表示されます。</div>
             <div class="preview-meta">Blueskyへの公開ポスト</div>
           </div>
           <div class="preview-state" data-preview-state>配信開始時に投稿されます</div>
         </aside>
       </div>`
    : `<div class="empty-state">
         <p>連携しているチャンネルはまだありません。</p>
         <p class="help-text">下の「チャンネル連携」から、自分のチャンネルを連携してください。</p>
       </div>`;
  return htmlPage(
    "orbsky - 投稿設定",
    `<div class="channel-page-header">
       <div>
         <span class="eyebrow">チャンネル連携</span>
         <h1>投稿設定</h1>
         <p>配信開始時にBlueskyへ投稿する内容を設定します。</p>
       </div>
       <div class="connection-summary" aria-label="連携状態">
         <span class="compact-status ${bskyDid ? "is-success" : ""}">Bluesky ${bskyDid ? "連携済み" : "未連携"}</span>
         <span>${connections.length}チャンネル</span>
         ${canUseMultiChannel ? "<span>マルチチャンネル利用可</span>" : ""}
       </div>
     </div>
     ${postingSaved ? '<div class="notice" role="status">チャンネルの自動ポスト設定を保存しました。</div>' : ""}
     ${editor}
     <details class="management-disclosure"${connections.length ? "" : " open"}>
       <summary>
         <span><strong>チャンネル連携</strong><small>チャンネルの追加と連携管理</small></span>
       </summary>
       <div class="management-grid">
         <section>
           <h2>自分のチャンネル</h2>
           <p>ログイン中のTwitchアカウントが管理するチャンネルを連携します。</p>
           <form method="post" action="${CHANNELS_CONNECT_PATH}">
             <input type="hidden" name="csrf" value="${session.csrf}">
             <button class="button-secondary" type="submit">自分のチャンネルを連携する</button>
           </form>
         </section>
         <section>
           <h2>マルチチャンネル設定</h2>
           ${multiChannelSettings}
         </section>
       </div>
       <p class="help-text">自動ポストのON/OFF、本文、配信タイトル・カテゴリの使用は、すべてのプランで利用できます。</p>
     </details>`,
    { session, mainClass: "channels-page", currentPath: CHANNELS_PATH },
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
    return renderInvalidRequest(session);
  }

  try {
    const secret = await env.STATE.get(WEBHOOK_SECRET_KEY);
    if (!secret) {
      logError("channels", "webhook secret not configured");
      return renderOperationUnavailable(session);
    }
    const user = await fetchOwnTwitchUser(env, session.twitchUserId);
    const existing = await findConnectionByChannel(env, user.id, user.id);
    if (!existing) {
      // 特典ゲート: 無料は1チャンネルまで、特典(Fanboxコード or Twitchサブスク)で複数可
      const count = await listConnections(env, session.twitchUserId);
      if (count.length >= 1 && !(await hasActiveEntitlement(env, session.twitchUserId))) {
        return renderMessage({
          title: "特典",
          heading: "複数チャンネルには特典が必要です",
          body: "<p>連携できるチャンネルは無料利用では1つまでです。サポートコードまたはTwitchサブスクで複数連携が解放されます。</p>",
          primary: { href: SUPPORT_PATH, label: "特典ページへ" },
          session,
        });
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
    if (err instanceof TwitchOAuthError) {
      return renderReauthRequired(session);
    }
    return renderMessage({
      title: "エラー",
      heading: "連携に失敗しました",
      tone: "error",
      body: "<p>時間をおいてもう一度お試しください。改善しない場合はお問い合わせください。</p>",
      secondary: { href: CHANNELS_PATH, label: "チャンネル連携に戻る" },
      session,
    });
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
    return renderInvalidRequest(session);
  }
  if (!login) {
    return renderMessage({
      title: "エラー",
      heading: "Twitchユーザー名を確認してください",
      tone: "error",
      body: "<p>Twitchユーザー名を正しく入力してください。</p>",
      secondary: { href: CHANNELS_PATH, label: "チャンネル連携に戻る" },
      session,
    });
  }
  if (!(await hasActiveEntitlement(env, session.twitchUserId))) {
    return renderMessage({
      title: "特典",
      heading: "マルチチャンネルには特典が必要です",
      body: "<p>複数のTwitchチャンネルを追加するには、サポートコードまたはTwitchサブスク特典の有効化が必要です。</p>",
      primary: { href: SUPPORT_PATH, label: "特典ページへ" },
      session,
    });
  }

  try {
    const secret = await env.STATE.get(WEBHOOK_SECRET_KEY);
    if (!secret) {
      logError("channels", "webhook secret not configured");
      return renderOperationUnavailable(session);
    }
    const channel = await fetchTwitchUserByLogin(env, login);
    if (!channel) {
      return renderMessage({
        title: "エラー",
        heading: "チャンネルが見つかりません",
        tone: "error",
        body: "<p>Twitchチャンネルが見つかりません。ユーザー名を確認してください。</p>",
        secondary: { href: CHANNELS_PATH, label: "チャンネル連携に戻る" },
        session,
      });
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
    return renderMessage({
      title: "エラー",
      heading: "連携に失敗しました",
      tone: "error",
      body: "<p>時間をおいてもう一度お試しください。改善しない場合はお問い合わせください。</p>",
      secondary: { href: CHANNELS_PATH, label: "チャンネル連携に戻る" },
      session,
    });
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
    return renderInvalidRequest(session);
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
    return renderMessage({
      title: "エラー",
      heading: "連携解除に失敗しました",
      tone: "error",
      body: "<p>時間をおいてもう一度お試しください。改善しない場合はお問い合わせください。</p>",
      secondary: { href: CHANNELS_PATH, label: "チャンネル連携に戻る" },
      session,
    });
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
  // hasSubResult は null = 未確認/確認失敗、true/false = 確認できたサブスク有無。
  // 表示文言ではなくこの真偽値を判定に使う(文言変更が特典判定に影響しないようにする)。
  let hasSubResult: boolean | null = null;
  if (subDisabled) {
    subStatus = "無効中";
    subActions = `<form method="post" action="${SUB_ENABLE_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button class="button-secondary" type="submit">サブスク判定を再有効化</button>
     </form>`;
  } else {
    hasSubResult = await hasTwitchSub(env, session.twitchUserId).catch(() => null);
    subStatus =
      hasSubResult === null
        ? "確認できません"
        : hasSubResult
          ? "サブスク中"
          : "サブスクなし";
    subActions = `<form method="post" action="${SUB_CHECK_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button class="button-secondary" type="submit">サブスク状態を再確認</button>
     </form>
     <form method="post" action="${SUB_DISABLE_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button class="text-button" type="submit">サブスク判定を無効にする</button>
     </form>`;
  }
  const entitlementActive = Boolean(rows) || hasSubResult === true;
  const entitlementSource = hasSubResult === true
    ? "Twitchサブスクで利用中"
    : rows
      ? "サポートコードで利用中"
      : "無料利用";

  return htmlPage(
    "orbsky - 特典",
    `<article class="focused-page support-page">
       <a class="back-link" href="/">トップへ戻る</a>
       <span class="eyebrow">特典</span>
       <h1>特典とマルチチャンネル</h1>
       <p class="lead">複数のTwitchチャンネルを連携するための利用状態を管理します。</p>

       <section class="focus-card benefit-summary">
         <div class="connection-state">
           <div><span>マルチチャンネル</span><strong>${entitlementSource}</strong></div>
           <span class="compact-status ${entitlementActive ? "is-primary" : ""}">${entitlementActive ? "利用中" : "未利用"}</span>
         </div>
         <p>${entitlementActive ? "複数のTwitchチャンネルを追加できます。" : "無料利用では1チャンネルまで連携できます。"}</p>
         <p><a class="button button-secondary" href="${CHANNELS_PATH}">チャンネル設定を開く</a></p>
       </section>

       <section class="focus-card">
         <h2>サポートコードを入力</h2>
         <p>別サービス <a href="${TWICA_URL}" target="_blank" rel="noopener noreferrer">twica</a> と同一のものをご利用いただけます。</p>
         <form class="support-code-form" method="post" action="${SUPPORT_ACTIVATE_PATH}">
           <input type="hidden" name="csrf" value="${session.csrf}">
           <div class="field">
             <label for="support_code">サポートコード</label>
             <input id="support_code" type="text" name="code" required placeholder="コードを入力">
           </div>
           <button type="submit">有効化</button>
         </form>

         <details class="inline-disclosure">
           <summary>サポートコードでできること・入手方法</summary>
           <div class="disclosure-content">
             <h3>サポートコードでできること</h3>
             <p>有効化すると、2つ目以降も追加して複数のTwitchチャンネルを連携できます。</p>
             <ul class="plan-list">
               <li><strong>サポーター:</strong> 複数チャンネル連携を利用できます。</li>
               <li><strong>パトロン:</strong> 複数チャンネル連携を利用できます。orbskyでは現在、サポーターと同じ特典内容です。</li>
             </ul>
             <h3>FANBOXでサポートコードを受け取る</h3>
             <p>支援後、FANBOXのメッセージまたは支援者向け投稿でコードを確認してください。</p>
             <p><a class="button button-secondary" href="${FANBOX_URL}" target="_blank" rel="noopener noreferrer">azumagのFANBOXを見る</a></p>
           </div>
         </details>

         <details class="inline-disclosure">
           <summary>現在のコード特典</summary>
           <div class="disclosure-content">
             <ul class="plan-list">${rows || "<li>(なし)</li>"}</ul>
             <form method="post" action="${SUPPORT_DEACTIVATE_PATH}">
               <input type="hidden" name="csrf" value="${session.csrf}">
               <button class="button-danger" type="submit">コード特典を解除</button>
             </form>
           </div>
         </details>
       </section>

       <details class="focus-card support-subscription">
         <summary>
           <span><strong>Twitchサブスク(azumagbanjo)</strong><small>判定状態と設定</small></span>
           <span class="compact-status ${hasSubResult === true ? "is-success" : ""}">${escapeHtml(subStatus)}</span>
         </summary>
         <div class="disclosure-content forms-stack">${subActions}</div>
       </details>
     </article>`,
    { session, currentPath: SUPPORT_PATH },
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
    return renderInvalidRequest(session);
  }

  try {
    const license = await activateCode(env, session.twitchUserId, code);
    logInfo("support", "code activated", {
      userId: session.twitchUserId,
      planType: license.planType,
    });
    return renderMessage({
      title: "特典",
      heading: "サポートコードを有効化しました",
      tone: "success",
      body: `<p>プラン: ${escapeHtml(supportPlanLabel(license.planType))}</p>
             <p>複数のTwitchチャンネルを連携できるようになりました。</p>`,
      primary: { href: CHANNELS_PATH, label: "チャンネル設定を開く" },
      secondary: { href: SUPPORT_PATH, label: "特典ページに戻る" },
      session,
    });
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
    return renderMessage({
      title: "特典",
      heading: "有効化できませんでした",
      tone: "error",
      body: `<p>${escapeHtml(message)}</p>`,
      secondary: { href: SUPPORT_PATH, label: "特典ページに戻る" },
      session,
    });
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
    return renderInvalidRequest(session);
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
    return renderInvalidRequest(session);
  }

  const result = await refreshTwitchSubCheck(env, session.twitchUserId);
  if (result === null) {
    return renderMessage({
      title: "特典",
      heading: "確認に失敗しました",
      tone: "error",
      body: "<p>再ログインが必要な場合があります。</p>",
      secondary: { href: SUPPORT_PATH, label: "特典ページに戻る" },
      session,
    });
  }
  return renderMessage({
    title: "特典",
    heading: result ? "サブスク中です" : "サブスクは見つかりませんでした",
    tone: result ? "success" : "info",
    body: result
      ? "<p>Twitchサブスクによる特典が利用できます。</p>"
      : "<p>Twitchで azumagbanjo のサブスクリプションが確認できませんでした。</p>",
    secondary: { href: SUPPORT_PATH, label: "特典ページに戻る" },
    session,
  });
}

async function handleSubDisable(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  if (!session || csrf !== session.csrf) {
    return renderInvalidRequest(session);
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
    return renderInvalidRequest(session);
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
    return renderMessage({
      title: "エラー",
      heading: "Bluesky連携を開始できませんでした",
      tone: "error",
      body: "<p>時間をおいてもう一度お試しください。</p>",
      secondary: { href: SETTINGS_PATH, label: "Bluesky設定に戻る" },
      session,
    });
  }
}

async function handleBskyCallback(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getSession(env, request);
  if (!session) {
    return renderMessage({
      title: "エラー",
      heading: "ログインが必要です",
      tone: "error",
      body: "<p>Twitchでログインしてから、もう一度お試しください。</p>",
      primary: { href: LOGIN_PATH, label: "Twitchでログインする" },
      session: null,
    });
  }
  try {
    const { did } = await completeBskyAuthorization(env, new URL(request.url).searchParams);
    await bindBskySessionToUser(env, session.twitchUserId, did);
    logInfo("bsky", "oauth completed", { userId: session.twitchUserId, did });
    return new Response(null, { status: 302, headers: { Location: SETTINGS_PATH } });
  } catch (err) {
    logError("bsky", "oauth callback failed", err, { userId: session.twitchUserId });
    return renderMessage({
      title: "エラー",
      heading: "Bluesky連携に失敗しました",
      tone: "error",
      body: "<p>もう一度お試しください。</p>",
      secondary: { href: SETTINGS_PATH, label: "Bluesky設定に戻る" },
      session,
    });
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
    return renderInvalidRequest(session);
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
    return renderInvalidRequest(session);
  }
  const connectionIdRaw = form?.get("connection_id");
  const connectionId =
    typeof connectionIdRaw === "string" ? Number(connectionIdRaw) : NaN;
  const postTemplateRaw = form?.get("post_template");
  const postTemplate =
    typeof postTemplateRaw === "string" ? postTemplateRaw.trim() : "";
  if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
    return renderInvalidRequest(session);
  }
  const templateError = validatePostTemplate(postTemplate);
  if (templateError) {
    return renderMessage({
      title: "エラー",
      heading: "投稿文を確認してください",
      tone: "error",
      body: `<p>${escapeHtml(templateError)}</p>`,
      secondary: {
        href: `${CHANNELS_PATH}#channel-${connectionId}`,
        label: "チャンネル設定に戻る",
      },
      session,
    });
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
      return renderMessage({
        title: "エラー",
        heading: "チャンネル設定を保存できませんでした",
        tone: "error",
        body: "<p>チャンネルの連携状態を確認してください。</p>",
        secondary: { href: CHANNELS_PATH, label: "チャンネル連携に戻る" },
        session,
      });
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
    return renderMessage({
      title: "エラー",
      heading: "設定の保存に失敗しました",
      tone: "error",
      body: "<p>時間をおいてもう一度お試しください。</p>",
      secondary: {
        href: `${CHANNELS_PATH}#channel-${connectionId}`,
        label: "チャンネル設定に戻る",
      },
      session,
    });
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
    ? `<div class="connection-state">
         <div><span>Bluesky連携</span><strong>接続済み</strong></div>
         <span class="compact-status is-success">連携済み</span>
       </div>
       <p>このアカウントへ、配信中ステータスと自動ポストを反映します。</p>
       <details class="inline-disclosure">
         <summary>連携アカウントを管理</summary>
         <p class="help-text">DID: ${escapeHtml(did)}</p>
         <form method="post" action="${BSKY_DISCONNECT_PATH}">
           <input type="hidden" name="csrf" value="${session.csrf}">
           <button class="button-danger" type="submit">連携を解除</button>
         </form>
       </details>`
    : `<div class="connection-state">
         <div><span>Bluesky連携</span><strong>未連携</strong></div>
         <span class="compact-status">設定が必要</span>
       </div>
       <p>配信ステータスを反映するBlueskyアカウントを選択してください。</p>
       <p><a class="button" href="${BSKY_LOGIN_PATH}">Blueskyと連携</a></p>
       <p><small>連携画面でログインまたはアカウント選択ができます。</small></p>`;
  return htmlPage(
    "orbsky - 設定",
    `<article class="focused-page">
       <a class="back-link" href="/">トップへ戻る</a>
       <span class="eyebrow">連携</span>
       <h1>Bluesky設定</h1>
       <p class="lead">投稿先のBlueskyアカウントを管理します。</p>
       <section class="focus-card">
         ${body}
         <div class="next-action">
           <div>
             <strong>配信開始時の自動ポスト</strong>
             <span>本文とON/OFFはチャンネルごとに設定できます。すべてのプランで利用できます。</span>
           </div>
           <a class="button button-secondary" href="${CHANNELS_PATH}">投稿設定を開く</a>
         </div>
       </section>
     </article>`,
    { session, currentPath: SETTINGS_PATH },
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
    if (url.pathname === PRIVACY_PATH && request.method === "GET") {
      return renderPrivacy();
    }
    if (url.pathname === GUIDE_PATH && request.method === "GET") {
      const session = await getSession(env, request);
      return renderGuide(session);
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
