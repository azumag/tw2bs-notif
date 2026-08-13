import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("tw2bs-notif worker", () => {
  it("responds with the login page on GET /", async () => {
    const response = await exports.default.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Twitchでログイン");
    expect(body).toContain('href="/guide"');
    expect(body).toContain('href="/privacy"');
    expect(body).toContain("data-theme-toggle");
    expect(body).toContain('localStorage.getItem("orbsky-theme")');
    expect(body).toContain("prefers-color-scheme: dark");
  });

  it("ヘッダー・フッターにブランドロゴ(丸いエンブレム+rbsky)が表示される", async () => {
    const response = await exports.default.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const body = await response.text();
    // ヘッダーとフッターで1回ずつ描画され、グラデーションIDが衝突しない。
    expect(body.match(/class="brand-orb"/g)?.length).toBe(2);
    expect(body).toContain('id="orb-ring-h"');
    expect(body).toContain('id="orb-ring-f"');
    expect(body).toContain('<span class="brand-word">rbsky</span>');
    expect(body).toContain('aria-label="orbsky トップ"');
    expect(body).toContain('rel="icon"');
    expect(body).toContain('href="/logo"');
  });

  it("ログイン前でも機能概要・使い方ページを読める", async () => {
    const response = await exports.default.fetch("https://example.com/guide");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("orbsky の機能概要・使い方");
    expect(body).toContain("orbskyでできること");
    expect(body).toContain("Twitchでログイン");
    expect(body).toContain("Blueskyアカウントを連携");
    expect(body).toContain("自動ポスト本文のカスタマイズ");
    expect(body).toContain("{title}");
    expect(body).toContain("無料利用とマルチチャネル機能");
    expect(body).toContain("twica");
    expect(body).toContain('href="https://twica.bluemoon.works/plans"');
    expect(body).toContain('href="/privacy"');
    expect(body).toContain("data-theme-toggle");
  });

  it("ログイン前でもプライバシーポリシーを読める", async () => {
    const response = await exports.default.fetch("https://example.com/privacy");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("プライバシーポリシー");
    expect(body).toContain("Twitchアカウントのメールアドレスを保存しません");
    expect(body).toContain("Blueskyのパスワードは取得・保存しません");
    expect(body).toContain("ログインセッションは最長30日");
    expect(body).toContain("ログアウトはブラウザのログインセッションのみを削除");
    expect(body).toContain("https://legal.twitch.com/legal/privacy-notice/");
    expect(body).toContain("https://bsky.social/about/support/privacy-policy");
    expect(body).toContain("https://www.cloudflare.com/privacypolicy/");
  });

  it("ログイン前でも運営者情報ページを読める", async () => {
    const response = await exports.default.fetch("https://example.com/about");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("運営者情報");
    expect(body).toContain("azumag");
    expect(body).toContain("https://x.com/azumag");
    expect(body).toContain("https://bsky.app/profile/azumag.bsky.social");
    expect(body).toContain("https://www.twitch.tv/azumagbanjo");
    expect(body).toContain("https://github.com/azumag");
    expect(body).toContain('href="https://azumag.fanbox.cc/"');
  });

  it("ログイン前でもロゴページを読め、ライト標準・ダークLIVEの両ロゴが表示される", async () => {
    const response = await exports.default.fetch("https://example.com/logo");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<h1>ロゴ</h1>");
    expect(body).toContain("logo-swatch-light");
    expect(body).toContain("logo-swatch-dark");
    expect(body).toContain("ライトテーマ・標準");
    expect(body).toContain("ダークテーマ・配信中(ライブ)");
    // ダーク側のロックアップだけがLIVEバッジ(brand-live)を持つ。
    expect(body.match(/class="brand-orb brand-live"/g)?.length).toBe(1);
    // ヘッダー・フッター・ライト用・ダーク用の4つのエンブレムがすべて一意なIDを持つ。
    expect(body).toContain('id="orb-ring-h"');
    expect(body).toContain('id="orb-ring-f"');
    expect(body).toContain('id="orb-ring-logo-a"');
    expect(body).toContain('id="orb-ring-logo-b"');
    // LIVEバッジのグラデーションもダーク側だけに存在する。
    expect(body).toContain('id="orb-live-logo-b"');
    expect(body).not.toContain('id="orb-live-logo-a"');
  });

  it("can read and write KV values", async () => {
    await env.STATE.put("test-key", "test-value");
    expect(await env.STATE.get("test-key")).toBe("test-value");
  });

  it("routes EventSub notifications through the webhook endpoint", async () => {
    const secret = "integration-secret";
    await env.STATE.put("twitch:webhook_secret", secret);

    const body = JSON.stringify({
      subscription: {
        id: "s1",
        type: "stream.online",
        version: "1",
        status: "enabled",
        created_at: "",
      },
      event: { id: "event-1", broadcaster_user_id: "12345" },
    });
    const messageId = "msg-1";
    const timestamp = new Date().toISOString();
    const signature = `sha256=${await hmacHex(secret, messageId + timestamp + body)}`;

    const response = await exports.default.fetch(
      "https://example.com/twitch/eventsub",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Twitch-Eventsub-Message-Type": "notification",
          "Twitch-Eventsub-Message-Id": messageId,
          "Twitch-Eventsub-Message-Timestamp": timestamp,
          "Twitch-Eventsub-Message-Signature": signature,
        },
        body,
      },
    );
    expect(response.status).toBe(202);
  });
});
