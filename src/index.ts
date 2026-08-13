import { EVENTSUB_PATH, handleEventSub } from "./lib/eventsub";
import {
  isStreamRenewal,
  processStreamEvent,
  processStreamRenewals,
} from "./lib/stream";
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
import type { QueueMessage, StreamRenewal } from "./lib/stream";
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
  updateConnectionPostOnStart,
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
import { renderHtmlPage, brandLockup, type PageOptions } from "./ui";

const LOGIN_PATH = "/auth/twitch/login";
const CALLBACK_PATH = "/auth/twitch/callback";
const LOGOUT_PATH = "/auth/logout";
const GUIDE_PATH = "/guide";
const PRIVACY_PATH = "/privacy";
const ABOUT_PATH = "/about";
const LOGO_PATH = "/logo";
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
const OPERATOR_X_URL = "https://x.com/azumag";
const OPERATOR_BSKY_URL = "https://bsky.app/profile/azumag.bsky.social";
const OPERATOR_TWITCH_URL = "https://www.twitch.tv/azumagbanjo";
const OPERATOR_GITHUB_URL = "https://github.com/azumag";
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
    secondary: { href: CHANNELS_PATH, label: "チャネル連携に戻る" },
    session,
  });
}

async function renderIndex(
  session: { twitchUserId: string; csrf: string } | null,
  env: AppEnv,
): Promise<Response> {
  if (!session) {
    return htmlPage(
      "orbsky",
      `<section class="hero">
         <div>
           <span class="hero-kicker">Twitch × Bluesky</span>
           <h1>Twitchの配信をBlueskyへ自動で反映</h1>
           <p class="hero-lead">配信開始・終了を検知して、Blueskyの配信中ステータスとお知らせ投稿へ自動で反映します。</p>
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
             <li>チャネルごとに投稿内容を設定</li>
           </ol>
         </aside>
       </section>`,
      { currentPath: "/" },
    );
  }
  const bskyDid = await getBskyDidForUser(env, session.twitchUserId);
  const dashboardFocus = bskyDid
    ? `<a class="dashboard-primary" href="${CHANNELS_PATH}">
         <span class="eyebrow">メイン</span>
         <strong>投稿設定を開く</strong>
         <span>自動ポストのON/OFFと本文をチャネルごとに編集</span>
       </a>
       <div class="dashboard-links" aria-label="その他の設定">
         <a href="${SETTINGS_PATH}"><strong>Bluesky連携</strong><span>投稿先を確認・変更</span></a>
         <a href="${SUPPORT_PATH}"><strong>マルチチャネル有効化</strong><span>複数チャネルを管理</span></a>
         <a href="${GUIDE_PATH}"><strong>使い方</strong><span>設定の流れを確認</span></a>
       </div>`
    : `<a class="dashboard-primary" href="${SETTINGS_PATH}">
         <span class="eyebrow">はじめに</span>
         <strong>Blueskyと連携する</strong>
         <span>配信中ステータスと自動ポストの投稿先を選択します</span>
       </a>
       <div class="dashboard-links" aria-label="その他の設定">
         <a href="${CHANNELS_PATH}"><strong>投稿設定</strong><span>自動ポストのON/OFFと本文を編集</span></a>
         <a href="${SUPPORT_PATH}"><strong>マルチチャネル有効化</strong><span>複数チャネルを管理</span></a>
         <a href="${GUIDE_PATH}"><strong>使い方</strong><span>設定の流れを確認</span></a>
       </div>`;
  return htmlPage(
    "orbsky",
    `<section class="dashboard">
       <div class="dashboard-focus">
         ${dashboardFocus}
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
       <a class="button button-secondary" href="${CHANNELS_PATH}">チャネル連携・自動ポストを設定する</a></div>`
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
       <div class="feature-item"><strong>チャネル別の自動ポスト</strong><span>投稿のON/OFF、本文、配信タイトル、カテゴリをチャネルごとに設定できます。</span></div>
       <div class="feature-item"><strong>マルチチャネル</strong><span>マルチチャネルを有効化すると、複数のTwitchチャネルを1つのBlueskyへ連携できます。</span></div>
     </div>
     <p>配信終了を検知すると、配信中バッジは自動で解除されます。</p>

     <h2>使い方</h2>
     <ol class="step-list">
       <li>
         <h3>Twitchでログイン</h3>
         <p>Twitchアカウントでorbskyへログインします。ご自身のTwitchチャネルはこの時点で自動的に連携されます。別のチャネルを追加する場合も、最初に管理用のTwitchアカウントでログインしてください。</p>
       </li>
       <li>
         <h3>Blueskyアカウントを連携</h3>
         <p><a href="${SETTINGS_PATH}">設定</a>から「Blueskyと連携」を選び、配信中バッジと自動ポストを反映するBlueskyアカウントを選択します。</p>
       </li>
       <li>
         <h3>自動ポストを設定</h3>
         <p>連携済みチャネルごとに、自動ポストのON/OFFと本文フォーマットを設定して保存します。本文に含めた変数だけが投稿に反映されます。</p>
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
         <tr><td><code>{channel}</code></td><td>連携したチャネル名</td></tr>
         <tr><td><code>{url}</code></td><td>連携したTwitchチャネルのURL</td></tr>
       </tbody>
     </table></div>
     <p>例:</p>
     <pre><code>🔴 {channel} が配信を始めました
{title}
カテゴリ: {category}
{url}</code></pre>
     <p>本文に書いた変数だけが投稿に反映されます。配信タイトルやカテゴリを含めたくない場合は、テンプレートからその変数を削除してください。</p>

     <h2>無料利用とマルチチャネル機能</h2>
     <div class="table-wrap"><table>
       <thead><tr><th>利用状態</th><th>連携できるTwitchチャネル</th><th>自動ポスト設定</th></tr></thead>
       <tbody>
         <tr><td>無料</td><td>1チャネル</td><td>利用可能</td></tr>
         <tr><td>マルチチャネル有効化</td><td>複数チャネル</td><td>各チャネルで利用可能</td></tr>
       </tbody>
     </table></div>
     <p>複数チャネル連携は、<a href="${SUPPORT_PATH}">マルチチャネル有効化ページ</a>でFANBOXサポートコードまたはTwitchサブスクを有効化すると利用できます。</p>
     <p>これは有料機能ではなく、サブスクライブや支援への返礼としての特典です。連携チャネルが増えるほど配信の監視と反映にかかるサーバー負荷が積み上がるため、標準は1チャネルとしています。</p>
     <p>サポートコードは、別サービス <a href="${TWICA_URL}" target="_blank" rel="noopener noreferrer">twica</a> と同一のものをご利用いただけます。</p>

     <h2>知っておきたいこと</h2>
     <ul>
       <li>自動ポストをOFFにしても、Blueskyの配信中バッジは反映されます。</li>
       <li>Blueskyが未連携の場合、配信中バッジと自動ポストは反映されません。</li>
       <li>設定はチャネルごとに保存されるため、複数チャネルで別々の本文を使えます。</li>
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
       <li>連携したTwitchチャネルのID、ユーザー名、表示名</li>
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
       <li>チャネルごとの自動ポストON/OFF、本文テンプレート、タイトル・カテゴリの使用設定</li>
       <li>サポートコードまたはTwitchサブスクによる特典の有効化状態、プラン、日時</li>
     </ul>
     <p>入力されたサポートコードはハッシュ値で照合し、平文のコードを保存しません。また、コードをFANBOXやtwicaへ送信することはありません。</p>

     <h3>技術情報</h3>
     <ul>
       <li>ログイン維持に必要なセッションクッキー</li>
       <li>OAuth認証に必要な一時的なstate情報</li>
       <li>アクセス日時、処理対象のアカウント・チャネル識別子、処理結果、エラーなどの運用ログ</li>
     </ul>
     <p>本サービスは広告配信や行動追跡を目的としたCookie、アクセス解析ツールを使用していません。</p>

     <h2>2. 利用目的</h2>
     <ul>
       <li>利用者の認証とログイン状態の維持</li>
       <li>TwitchチャネルとBlueskyアカウントの連携</li>
       <li>配信開始・終了の検知、配信中ステータスの表示・解除、自動ポスト</li>
       <li>チャネル別設定、サポート特典、マルチチャネル機能の提供</li>
       <li>不正利用の防止、障害調査、セキュリティ確保、サービス改善</li>
       <li>法令上必要な対応</li>
     </ul>

     <h2>3. 公開される情報</h2>
     <p>利用者がBluesky連携を有効にすると、配信中ステータス、Twitchチャネルへのリンク、および設定に応じた自動ポストがBlueskyとAT Protocolネットワーク上で公開されます。投稿本文には、設定に応じてTwitchの配信タイトル、カテゴリ、チャネル名、URLが含まれます。</p>

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
       <li>自動ポストは、チャネルごとに停止できます。</li>
       <li>チャネル連携、Bluesky連携、サポート特典は各設定画面から解除できます。</li>
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

function renderAbout(): Response {
  return htmlPage(
    "orbsky - 運営者情報",
    `<article class="content-page">
     <a class="back-link" href="/">トップへ戻る</a>
     <h1>運営者情報</h1>

     <h2>運営者</h2>
     <p>azumag</p>

     <h2>SNS・連絡先</h2>
     <div class="table-wrap"><table>
       <tbody>
         <tr><td>X (Twitter)</td><td><a href="${OPERATOR_X_URL}" target="_blank" rel="noopener noreferrer">@azumag</a></td></tr>
         <tr><td>Bluesky</td><td><a href="${OPERATOR_BSKY_URL}" target="_blank" rel="noopener noreferrer">@azumag.bsky.social</a></td></tr>
         <tr><td>Twitch</td><td><a href="${OPERATOR_TWITCH_URL}" target="_blank" rel="noopener noreferrer">azumagbanjo</a></td></tr>
         <tr><td>GitHub</td><td><a href="${OPERATOR_GITHUB_URL}" target="_blank" rel="noopener noreferrer">azumag</a></td></tr>
       </tbody>
     </table></div>

     <h2>支援する</h2>
     <p>orbskyの開発・運営を支援していただける方、気に入ったらご支援頂けますと幸いです。</p>
     <p class="action-row"><a class="button button-secondary" href="${FANBOX_URL}" target="_blank" rel="noopener noreferrer">azumagのFANBOXを見る</a></p>

     <h2>orbskyについて</h2>
     <p>orbskyは、Twitchの配信開始・終了を検知して、Blueskyの配信中ステータスとお知らせ投稿へ自動で反映するサービスです。</p>
     </article>`,
  );
}

function renderLogo(): Response {
  return htmlPage(
    "orbsky - ロゴ",
    `<article class="content-page logo-page">
     <a class="back-link" href="/">トップへ戻る</a>
     <h1>ロゴ</h1>
     <p class="lead">orbskyのブランドマーク。輪郭線だけのシンプルなリングで「orbsky」の O を表す。配信中はリングが赤に変わり、下部に「ライブ」バッジが重なる。</p>

     <figure class="logo-figure">
       <figcaption class="logo-caption">ライトテーマ・標準</figcaption>
       <div class="logo-swatch logo-swatch-light">
         <a class="brand brand-huge" href="/" aria-label="orbsky トップ">${brandLockup("logo-a")}</a>
       </div>
     </figure>

     <figure class="logo-figure">
       <figcaption class="logo-caption">ダークテーマ・配信中(ライブ)</figcaption>
       <div class="logo-swatch logo-swatch-dark">
         <a class="brand brand-huge" href="/" aria-label="orbsky トップ">${brandLockup("logo-b", { live: true })}</a>
       </div>
     </figure>

     <dl class="logo-specs">
       <div><dt>リング(標準)</dt><dd>linear-gradient(#8fd8ff, #4f8cf7, #2450c9)</dd></div>
       <div><dt>リング(配信中)</dt><dd>linear-gradient(#ff9a8a, #ff4d3d, #c41e2f)</dd></div>
       <div><dt>ライブバッジ</dt><dd>linear-gradient(#ff6b5c, #e0273c)</dd></div>
       <div><dt>ワードマーク</dt><dd>太字幾何学サンセリフ / グラデーション塗り / letter-spacing -0.02em</dd></div>
     </dl>
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
    // ログインしたTwitchアカウント自身のチャネルを自動で連携する。
    // 失敗してもログイン自体は継続する(/channels の再連携で復旧できる)。
    await connectOwnChannel(env, user.id).catch((err) => {
      logError("auth", "auto-connect own channel failed", err, {
        twitchUserId: user.id,
      });
    });
    // Bluesky未連携なら、投稿設定より先に連携画面へ誘導する
    // (投稿先が無いと自動ポストを設定しても意味が無いため)。
    const bskyDid = await getBskyDidForUser(env, user.id);
    return new Response(null, {
      status: 302,
      headers: {
        Location: bskyDid ? "/" : SETTINGS_PATH,
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
               <span class="eyebrow">チャネル</span>
               <h2 id="channel-heading-${suffix}">${escapeHtml(c.twitchDisplayName)} <small>@${escapeHtml(c.twitchLogin)}</small></h2>
             </div>
             <div class="switch-group">
               <label class="switch-line" for="post_on_start_${suffix}">
                 <span>自動ポスト</span>
                 <input id="post_on_start_${suffix}" type="checkbox" role="switch" name="post_on_start" value="1"${c.postOnStart ? " checked" : ""}
                   data-post-on-start>
               </label>
               <span class="switch-status" data-post-on-start-status role="status"></span>
             </div>
           </div>
           <p class="panel-intro">自動ポストをONにすると、配信開始を検知したときにBlueskyへ投稿します。</p>
           <div class="posting-fields"${c.postOnStart ? "" : " hidden"} data-posting-fields>
             <div class="field">
               <label for="post_template_${suffix}">投稿文</label>
               <textarea id="post_template_${suffix}" name="post_template" rows="6" maxlength="${MAX_POST_TEMPLATE_LENGTH}"
                 data-post-template required>${escapeHtml(c.postTemplate)}</textarea>
             </div>
             <div class="variable-group">
               <strong class="section-label">差し込み項目</strong>
               <span class="help-text">投稿文に含めたい項目だけをタップして挿入してください。不要な項目は本文から削除すれば投稿に含まれません。</span>
               <div class="variable-buttons">
                 <button class="variable-chip" type="button" data-insert-token="{title}">{title}<span>タイトル</span></button>
                 <button class="variable-chip" type="button" data-insert-token="{category}">{category}<span>カテゴリ</span></button>
                 <button class="variable-chip" type="button" data-insert-token="{channel}">{channel}<span>チャネル</span></button>
                 <button class="variable-chip" type="button" data-insert-token="{url}">{url}<span>URL</span></button>
               </div>
             </div>
           </div>
           <div class="action-row">
             <button type="submit">変更を保存</button>
           </div>
           <div class="channel-actions">
             <strong>このチャネルの連携</strong>
             <p>解除すると、配信状態と自動ポストが反映されなくなります。</p>
             <button class="button-danger" type="submit" formaction="${CHANNELS_DISCONNECT_PATH}" formmethod="post" formnovalidate>連携を解除</button>
           </div>
         </form>
       </section>`;
    })
    .join("");
  const multiChannelSettings = canUseMultiChannel
    ? `<p>ご自身が管理している別のTwitchチャネルのユーザー名を入力してください。</p>
       <form class="inline-form" method="post" action="${CHANNELS_ADD_PATH}">
         <input type="hidden" name="csrf" value="${session.csrf}">
         <div class="field">
           <label for="channel_login">Twitchユーザー名</label>
           <input id="channel_login" type="text" name="channel_login" required placeholder="例: azumagsandbox">
         </div>
         <button type="submit">通知対象のTwitchチャネルを追加する</button>
       </form>`
    : `<p><a href="${SUPPORT_PATH}">複数のチャネルからの通知を受け取るには</a></p>`;
  const header = `<div class="channel-page-header">
       <div>
         <span class="eyebrow">チャネル連携</span>
         <h1>投稿設定</h1>
         <p>配信開始時にBlueskyへ投稿する内容を設定します。</p>
       </div>
       <div class="connection-summary" aria-label="連携状態">
         <span class="compact-status ${bskyDid ? "is-success" : ""}">Bluesky ${bskyDid ? "連携済み" : "未連携"}</span>
         <span>${connections.length}チャネル</span>
         ${canUseMultiChannel ? "<span>マルチチャネル利用可</span>" : ""}
       </div>
     </div>
     ${postingSaved ? '<div class="notice" role="status">チャネルの自動ポスト設定を保存しました。</div>' : ""}`;

  // 自分のチャネルはTwitchログイン時に自動で連携される。ここに来る時点で
  // 未連携なのは、その自動連携が何らかの理由で失敗した場合のみなので、
  // 通常導線ではなく再試行カードとして表示する。
  const startCard = connections.length
    ? ""
    : `<section class="focus-card message-card is-error">
         <div class="connection-state">
           <div><span>チャネル連携</span><strong>未連携</strong></div>
           <span class="compact-status">連携が必要</span>
         </div>
         <p>ログイン時にご自身のTwitchチャネルの連携に失敗した可能性があります。もう一度お試しください。</p>
         <form class="action-row" method="post" action="${CHANNELS_CONNECT_PATH}">
           <input type="hidden" name="csrf" value="${session.csrf}">
           <button type="submit">自分のチャネルを連携し直す</button>
         </form>
       </section>`;

  const editor = connections.length
    ? `${connections.length > 1 ? `<span class="section-label">編集するチャネル</span>
       <div class="channel-tabs" role="tablist" aria-label="連携済みチャネル">${tabs}</div>` : ""}
       <div class="channel-workspace">
         <div>${panels}</div>
         <aside class="post-preview"${connections[0]?.postOnStart ? "" : " hidden"} data-post-preview aria-live="polite">
           <h2>投稿プレビュー</h2>
           <div class="preview-card">
             <div class="preview-author">
               <strong>orbsky</strong>
               <span data-preview-channel>@channel</span>
             </div>
             <div class="preview-text" data-preview-text>設定した投稿内容がここに表示されます。</div>
             <div class="preview-meta">Blueskyへの公開ポスト</div>
           </div>
           <div class="preview-state">配信開始時に投稿されます</div>
         </aside>
       </div>`
    : "";
  return htmlPage(
    "orbsky - 投稿設定",
    `${header}
     ${startCard}
     ${editor}
     <section class="management-section">
       <div class="management-heading">
         <strong>マルチチャネル</strong><small>通知対象チャネルの追加・管理</small>
       </div>
       ${multiChannelSettings}
       <p class="help-text">自動ポストのON/OFF、本文、配信タイトル・カテゴリの使用は、すべてのプランで利用できます。</p>
     </section>`,
    { session, mainClass: "channels-page", currentPath: CHANNELS_PATH },
  );
}

/**
 * ログイン中のTwitchアカウント自身のチャネルを connections へ登録し、
 * EventSub購読を確保する。自分のチャネルは無料枠そのものなので、
 * マルチチャネルの特典ゲートはかけない。
 * Twitchログイン直後に自動で呼ぶほか、失敗時のリトライ用に
 * handleConnectChannel からも呼ぶ。
 */
async function connectOwnChannel(
  env: AppEnv,
  twitchUserId: string,
): Promise<void> {
  const secret = await env.STATE.get(WEBHOOK_SECRET_KEY);
  if (!secret) {
    throw new Error("webhook secret not configured");
  }
  const user = await fetchOwnTwitchUser(env, twitchUserId);
  const existing = await findConnectionByChannel(env, user.id, user.id);
  if (!existing) {
    await insertConnection(env, twitchUserId, {
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
    await connectOwnChannel(env, session.twitchUserId);
    logInfo("channels", "connected channel", { userId: session.twitchUserId });
    return new Response(null, { status: 302, headers: { Location: CHANNELS_PATH } });
  } catch (err) {
    logError("channels", "connect failed", err);
    if (err instanceof TwitchOAuthError) {
      return renderReauthRequired(session);
    }
    if (err instanceof Error && err.message === "webhook secret not configured") {
      return renderOperationUnavailable(session);
    }
    return renderMessage({
      title: "エラー",
      heading: "連携に失敗しました",
      tone: "error",
      body: "<p>時間をおいてもう一度お試しください。改善しない場合はお問い合わせください。</p>",
      secondary: { href: CHANNELS_PATH, label: "チャネル連携に戻る" },
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
      secondary: { href: CHANNELS_PATH, label: "チャネル連携に戻る" },
      session,
    });
  }
  if (!(await hasActiveEntitlement(env, session.twitchUserId))) {
    return renderMessage({
      title: "マルチチャネル有効化",
      heading: "マルチチャネルの有効化が必要です",
      body: "<p>複数のTwitchチャネルを追加するには、サポートコードまたはTwitchサブスクでマルチチャネルを有効化してください。</p>",
      primary: { href: SUPPORT_PATH, label: "マルチチャネル有効化へ" },
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
        heading: "チャネルが見つかりません",
        tone: "error",
        body: "<p>Twitchチャネルが見つかりません。ユーザー名を確認してください。</p>",
        secondary: { href: CHANNELS_PATH, label: "チャネル連携に戻る" },
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
      secondary: { href: CHANNELS_PATH, label: "チャネル連携に戻る" },
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
      secondary: { href: CHANNELS_PATH, label: "チャネル連携に戻る" },
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
  let subPrimaryForm: string;
  let subDisableForm: string;
  // hasSubResult は null = 未確認/確認失敗、true/false = 確認できたサブスク有無。
  // 表示文言ではなくこの真偽値を判定に使う(文言変更が特典判定に影響しないようにする)。
  let hasSubResult: boolean | null = null;
  if (subDisabled) {
    subStatus = "判定を無効にしています";
    subPrimaryForm = `<form method="post" action="${SUB_ENABLE_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button type="submit">サブスク判定を再有効化</button>
     </form>`;
    subDisableForm = "";
  } else {
    hasSubResult = await hasTwitchSub(env, session.twitchUserId).catch(() => null);
    subStatus =
      hasSubResult === null
        ? "確認できません"
        : hasSubResult
          ? "サブスク中"
          : "サブスクなし";
    subPrimaryForm = `<form method="post" action="${SUB_CHECK_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button type="submit">サブスク状態を確認</button>
     </form>`;
    subDisableForm = `<form method="post" action="${SUB_DISABLE_PATH}">
       <input type="hidden" name="csrf" value="${session.csrf}">
       <button class="text-button" type="submit">サブスク判定を無効にする</button>
     </form>`;
  }
  const entitlementActive = Boolean(rows) || hasSubResult === true;

  return htmlPage(
    "orbsky - マルチチャネル有効化",
    `<article class="focused-page support-page">
       <a class="back-link" href="/">トップへ戻る</a>
       <span class="eyebrow">マルチチャネル有効化</span>
       <div class="page-heading">
         <div>
           <h1>マルチチャネル機能</h1>
           <p>複数のTwitchチャネルをまとめて連携できるようになる機能です。</p>
         </div>
         <div class="status-badges">
           <span class="status-badge ${entitlementActive ? "is-primary" : ""}">${entitlementActive ? "有効" : "無効"}</span>
         </div>
       </div>

       <section class="focus-card">
         <h2>マルチチャネル機能とは</h2>
         <p>マルチチャネル機能を有効化すると、ご自身が管理する複数のTwitchチャネル(サブ垢や別配信チャネルなど)をまとめて連携し、チャネルごとに自動ポストを設定できるようになります。</p>
         <p class="callout">これは有料機能ではありません。サブスクライブや支援をしてくださった方への<strong>返礼としての特典</strong>です。orbskyの基本機能は今後も無料でお使いいただけます。</p>
         <h3>チャネル数制限について</h3>
         <p>連携できるチャネル数を制限しているのは、サーバー負荷が連携数に比例して増えるためです。1つのチャネルにつき、配信の開始・終了の受信、配信情報の問い合わせ、配信中バッジの維持が継続的に発生します。全員が無制限に連携できる形にすると運営を続けられなくなるため、標準は1チャネルとし、支援いただいた方にはその分を上乗せでお返しする形にしています。</p>
       </section>

       <section class="focus-card">
         <h2>有効化する方法</h2>
         <p>次のどちらかで有効化できます。どちらも、有効化すると2つ目以降のTwitchチャネルを追加できるようになります。</p>
         <h3>1. FANBOXのサポートコード</h3>
         <p>azumagのFANBOXで支援いただいた方にサポートコードをお渡ししています。支援後、FANBOXのメッセージまたは支援者向け投稿でコードを確認してください。コードは別サービス <a href="${TWICA_URL}" target="_blank" rel="noopener noreferrer">twica</a> と同一のものをご利用いただけます。</p>
         <p class="action-row"><a class="button button-secondary" href="${FANBOX_URL}" target="_blank" rel="noopener noreferrer">azumagのFANBOXを見る</a></p>
         <h3>2. Twitchサブスク</h3>
         <p>作者:あずまぐ(<a href="${OPERATOR_TWITCH_URL}" target="_blank" rel="noopener noreferrer">@azumagbanjo</a>)のTwitchチャネルをサブスクライブしている方へのおまけ特典です。サブスクライブ済みであれば、下のボタンで確認するだけで有効化されます。</p>
       </section>

       <section class="focus-card">
         <h2>サポートコードで有効化</h2>
         <form class="support-code-form" method="post" action="${SUPPORT_ACTIVATE_PATH}">
           <input type="hidden" name="csrf" value="${session.csrf}">
           <div class="field">
             <label for="support_code">サポートコード</label>
             <input id="support_code" type="text" name="code" required placeholder="コードを入力">
           </div>
           <button type="submit">有効化</button>
         </form>
         <details class="inline-disclosure">
           <summary>現在のコード特典</summary>
           <div class="disclosure-content">
             <ul class="plan-list">${rows || "<li>(なし)</li>"}</ul>
             <p class="help-text">サポーター・パトロンのどちらのコードでも、マルチチャネル機能を利用できます。</p>
             <form method="post" action="${SUPPORT_DEACTIVATE_PATH}">
               <input type="hidden" name="csrf" value="${session.csrf}">
               <button class="button-danger" type="submit">コード特典を解除</button>
             </form>
           </div>
         </details>
       </section>

       <section class="focus-card">
         <h2>Twitchサブスクで有効化</h2>
         <p><a href="${OPERATOR_TWITCH_URL}" target="_blank" rel="noopener noreferrer">azumagbanjoのTwitchチャネル</a>をサブスクライブしてから確認すると、マルチチャネル機能が有効になります。</p>
         <div class="connection-state is-under-heading">
           <div><span>Twitchサブスク(azumagbanjo)</span><strong>${escapeHtml(subStatus)}</strong></div>
           <span class="compact-status ${hasSubResult === true ? "is-success" : ""}">${hasSubResult === true ? "有効" : "未反映"}</span>
         </div>
         <div class="action-row">${subPrimaryForm}</div>
         ${subDisableForm}
       </section>
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
      title: "マルチチャネル有効化",
      heading: "サポートコードを有効化しました",
      tone: "success",
      body: `<p>プラン: ${escapeHtml(supportPlanLabel(license.planType))}</p>
             <p>複数のTwitchチャネルを連携できるようになりました。</p>`,
      primary: { href: CHANNELS_PATH, label: "チャネル設定を開く" },
      secondary: { href: SUPPORT_PATH, label: "マルチチャネル有効化に戻る" },
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
      title: "マルチチャネル有効化",
      heading: "有効化できませんでした",
      tone: "error",
      body: `<p>${escapeHtml(message)}</p>`,
      secondary: { href: SUPPORT_PATH, label: "マルチチャネル有効化に戻る" },
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
      title: "マルチチャネル有効化",
      heading: "確認に失敗しました",
      tone: "error",
      body: "<p>再ログインが必要な場合があります。</p>",
      secondary: { href: SUPPORT_PATH, label: "マルチチャネル有効化に戻る" },
      session,
    });
  }
  return renderMessage({
    title: "マルチチャネル有効化",
    heading: result ? "サブスク中です" : "サブスクは見つかりませんでした",
    tone: result ? "success" : "info",
    body: result
      ? "<p>Twitchサブスクによる特典が利用できます。</p>"
      : "<p>Twitchで azumagbanjo のサブスクリプションが確認できませんでした。</p>",
    secondary: { href: SUPPORT_PATH, label: "マルチチャネル有効化に戻る" },
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
    try {
      await env.STATE.put(
        "debug:bsky_auth_error",
        JSON.stringify({
          at: new Date().toISOString(),
          name: err instanceof Error ? err.name : String(err),
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch {
      // 診断用のため失敗は無視
    }
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

  // 自動ポストのトグルは切り替えた時点で保存する(投稿文は対象外)。
  // ページ遷移を伴わない fetch から呼ばれるため、本文なしのステータスだけを返す。
  if (form?.get("only") === "post_on_start") {
    try {
      const updated = await updateConnectionPostOnStart(
        env,
        session.twitchUserId,
        connectionId,
        form.get("post_on_start") === "1",
      );
      if (!updated) {
        return new Response(null, { status: 404 });
      }
      logInfo("settings", "toggled channel post_on_start", {
        userId: session.twitchUserId,
        connectionId,
      });
      return new Response(null, { status: 204 });
    } catch (err) {
      logError("settings", "channel post_on_start toggle failed", err, {
        userId: session.twitchUserId,
        connectionId,
      });
      return new Response(null, { status: 500 });
    }
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
        label: "チャネル設定に戻る",
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
      },
    );
    if (!updated) {
      return renderMessage({
        title: "エラー",
        heading: "チャネル設定を保存できませんでした",
        tone: "error",
        body: "<p>チャネルの連携状態を確認してください。</p>",
        secondary: { href: CHANNELS_PATH, label: "チャネル連携に戻る" },
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
        label: "チャネル設定に戻る",
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
       <div class="next-action">
         <div>
           <strong>🔴 配信中バッジ</strong>
           <span>配信を始めると、このアカウントのBlueskyプロフィールに自動で表示されます</span>
         </div>
         <span class="compact-status is-success">有効</span>
       </div>
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
       <p class="action-row"><a class="button" href="${BSKY_LOGIN_PATH}">Blueskyと連携</a></p>
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
             <span>本文とON/OFFはチャネルごとに設定できます。すべてのプランで利用できます。</span>
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
    if (url.pathname === ABOUT_PATH && request.method === "GET") {
      return renderAbout();
    }
    if (url.pathname === LOGO_PATH && request.method === "GET") {
      return renderLogo();
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
      return renderIndex(session, env);
    }
    return new Response("Not Found", { status: 404 });
  },
  async queue(batch: MessageBatch<QueueMessage>, env: AppEnv): Promise<void> {
    // 延長はバッチ内でまとめて処理する。生存確認の Helix 問い合わせを
    // 1リクエストに畳めるので、同時配信数が増えても呼び出し回数が増えない。
    const renewals: StreamRenewal[] = [];
    for (const message of batch.messages) {
      if (isStreamRenewal(message.body)) {
        renewals.push(message.body);
        continue;
      }
      await processStreamEvent(env, message.body);
    }
    await processStreamRenewals(env, renewals);
  },
} satisfies ExportedHandler<AppEnv, QueueMessage>;
