import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import type { AppEnv } from "../src/types";
import { createSession } from "../src/lib/session";
import { migrations } from "./migrations";

function makeEnv(): AppEnv {
  return {
    ...env,
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    TWITCH_BROADCASTER_ID: "12345",
    BSKY_HANDLE: "test.bsky.social",
    BSKY_APP_PASSWORD: "test-app-password",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    TWITCH_OAUTH_REDIRECT_URL: env.TWITCH_OAUTH_REDIRECT_URL,
    EVENTSUB_CALLBACK_URL: env.EVENTSUB_CALLBACK_URL,
  } as AppEnv;
}

beforeAll(async () => { await applyD1Migrations(env.DB, migrations as D1Migration[]); });
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM pending_metadata_posts").run();
  await env.DB.prepare("DELETE FROM channel_metadata").run();
  await env.DB.prepare("DELETE FROM connections").run();
  await env.STATE.delete("twitch:token");
  await env.STATE.put("twitch:webhook_secret", "webhook-secret");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600, token_type: "bearer" }), { headers: { "Content-Type": "application/json" } });
    if (url.includes("helix/channels?broadcaster_id=12345")) return new Response(JSON.stringify({ data: [{ title: "現在のタイトル", game_name: "Music" }] }), { headers: { "Content-Type": "application/json" } });
    if (url.includes("eventsub/subscriptions") && !init?.method) return new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } });
    if (url.includes("eventsub/subscriptions") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.type).toBe("channel.update");
      expect(body.version).toBe("2");
      return new Response(JSON.stringify({ data: [{ id: "sub-update", status: "enabled", ...body, created_at: "" }] }), { headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected request: ${url}`);
  }));
});

describe("配信情報到昖耭定", () => {
  it("action・N分・テンプレートを保存し channel.update を購読する", async () => {
    const env0 = makeEnv();
    const inserted = await env0.DB.prepare(`INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name) VALUES ('12345','12345','azumagbanjo','あずまぐ')`).run();
    const connectionId = Number(inserted.meta.last_row_id);
    const { token, csrf } = await createSession(env0, "12345");
    const request = new Request("https://example.com/channels/metadata", {
      method: "POST",
      headers: { Cookie: `orbsky_session=${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf,
        connection_id: String(connectionId),
        title_change_action: "status_and_post",
        category_change_action: "status_only",
        metadata_coalesce_enabled: "1",
        metadata_coalesce_minutes: "5",
        title_change_template: "タイトル変更: {title}\n{url}",
        category_change_template: "カテゴリ変更: {category}\n{url}",
        combined_change_template: "更新: {title}\n{category}\n{url}",
      }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env0, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(302);
    const row = await env0.DB.prepare(`SELECT title_change_action AS titleAction, category_change_action AS categoryAction, metadata_coalesce_enabled AS enabled, metadata_coalesce_minutes AS minutes FROM connections WHERE id = ?`).bind(connectionId).first<{ titleAction: string; categoryAction: string; enabled: number; minutes: number }>();
    expect(row).toEqual({ titleAction: "status_and_post", categoryAction: "status_only", enabled: 1, minutes: 5 });
    const baseline = await env0.DB.prepare(`SELECT title, category FROM channel_metadata WHERE twitch_channel_id = '12345'`).first<{ title: string; category: string }>();
    expect(baseline).toEqual({ title: "現在のタイトル", category: "Music" });
  });
});
