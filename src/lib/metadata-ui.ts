import type { AppEnv } from "../types";
import { MAX_POST_TEMPLATE_LENGTH } from "./post-template";
import { getSession } from "./session";
import { renderHtmlPage } from "../ui";
import { listMetadataSharingSettings } from "./metadata-settings";
import type { MetadataChangeAction } from "./metadata-types";

export const METADATA_SETTINGS_PATH = "/channels/metadata";
const CHANNELS_PATH = "/channels";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function actionOptions(current: MetadataChangeAction): string {
  const options: Array<[MetadataChangeAction, string]> = [
    ["off", "反映しない"],
    ["status_only", "配信中ステータスのみ更新"],
    ["status_and_post", "ステータス更新＋通常ポスト"],
  ];
  return options.map(([value, label]) => `<option value="${value}"${current === value ? " selected" : ""}>${label}</option>`).join("");
}

export async function renderMetadataSettings(request: Request, env: AppEnv): Promise<Response> {
  const session = await getSession(env, request);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/" } });
  const settings = await listMetadataSharingSettings(env, session.twitchUserId);
  const saved = new URL(request.url).searchParams.get("saved") === "1";
  const panels = settings.map((setting) => `<section class="focus-card" id="metadata-${setting.id}">
    <h2>${escapeHtml(setting.twitchDisplayName)} <small>@${escapeHtml(setting.twitchLogin)}</small></h2>
    <form method="post" action="${METADATA_SETTINGS_PATH}">
      <input type="hidden" name="csrf" value="${session.csrf}">
      <input type="hidden" name="connection_id" value="${setting.id}">
      <div class="field"><label for="title_action_${setting.id}">配信タイトル変更</label><select id="title_action_${setting.id}" name="title_change_action">${actionOptions(setting.titleChangeAction)}</select></div>
      <div class="field"><label for="category_action_${setting.id}">カテゴリ変更</label><select id="category_action_${setting.id}" name="category_change_action">${actionOptions(setting.categoryChangeAction)}</select></div>
      <label class="switch-line" for="coalesce_${setting.id}"><span>短時間の変更を1回のポストにまとめる</span><input id="coalesce_${setting.id}" type="checkbox" role="switch" name="metadata_coalesce_enabled" value="1"${setting.metadataCoalesceEnabled ? " checked" : ""}></label>
      <div class="field"><label for="minutes_${setting.id}">まとめる時間（分）</label><input id="minutes_${setting.id}" type="number" name="metadata_coalesce_minutes" min="1" max="60" step="1" value="${setting.metadataCoalesceMinutes}" required><span class="help-text">通常ポストだけを待機してまとめます。配信中ステータスは変更直後に更新します。</span></div>
      <details class="inline-disclosure"><summary>変更時のポスト本文を編集</summary><div class="disclosure-content">
        <p class="help-text"><code>{title}</code> / <code>{category}</code> / <code>{channel}</code> / <code>{url}</code> が使えます。</p>
        <div class="field"><label for="title_template_${setting.id}">タイトル変更</label><textarea id="title_template_${setting.id}" name="title_change_template" rows="4" maxlength="${MAX_POST_TEMPLATE_LENGTH}" required>${escapeHtml(setting.titleChangeTemplate)}</textarea></div>
        <div class="field"><label for="category_template_${setting.id}">カテゴリ変更</label><textarea id="category_template_${setting.id}" name="category_change_template" rows="4" maxlength="${MAX_POST_TEMPLATE_LENGTH}" required>${escapeHtml(setting.categoryChangeTemplate)}</textarea></div>
        <div class="field"><label for="combined_template_${setting.id}">タイトル＋カテゴリ変更</label><textarea id="combined_template_${setting.id}" name="combined_change_template" rows="4" maxlength="${MAX_POST_TEMPLATE_LENGTH}" required>${escapeHtml(setting.combinedChangeTemplate)}</textarea></div>
      </div></details>
      <div class="action-row"><button type="submit">変更を保存</button></div>
    </form>
  </section>`).join("\n");
  const body = `<article class="focused-page"><a class="back-link" href="${CHANNELS_PATH}">投稿設定に戻る</a><span class="eyebrow">チャネル連携</span><h1>配信情報変更時の共有</h1><p class="lead">配信中にタイトルやカテゴリを変更したとき、Blueskyの配信中ステータスだけを更新するか、通常ポストも作るかをチャネルごとに設定します。</p>${saved ? '<div class="notice" role="status">配信情報変更時の共有設定を保存しました。</div>' : ""}${panels || '<section class="focus-card"><p>連携済みチャネルがありません。</p></section>'}</article>`;
  return new Response(renderHtmlPage("orbsky - 配信情報変更時の共有", body, { session, currentPath: CHANNELS_PATH }), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function decorateChannelsResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!response.ok || !contentType.includes("text/html")) return response;
  const html = await response.text();
  const card = `<section class="management-section"><div class="management-heading"><strong>配信情報変更時の共有</strong><small>タイトル・カテゴリ変更</small></div><p>配信中のタイトル・カテゴリ変更をBlueskyへどう反映するか設定できます。</p><p class="action-row"><a class="button button-secondary" href="${METADATA_SETTINGS_PATH}">変更時の共有設定を開く</a></p></section>`;
  const body = html.includes("</main>") ? html.replace("</main>", `${card}</main>`) : html;
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
