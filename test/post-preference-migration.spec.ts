import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrations } from "./migrations";

describe("0006_post-preference migration", () => {
  it("既存ユーザーの自動ポスト設定をONで初期化する", async () => {
    await applyD1Migrations(
      env.DB,
      migrations.slice(0, 5) as D1Migration[],
    );
    await env.DB.prepare(
      `INSERT INTO users (twitch_user_id, twitch_username, twitch_display_name)
       VALUES ('existing-user', 'existing', '既存ユーザー')`,
    ).run();

    await applyD1Migrations(
      env.DB,
      migrations.slice(5) as D1Migration[],
    );

    const row = await env.DB.prepare(
      `SELECT bsky_post_on_start AS enabled
       FROM users WHERE twitch_user_id = 'existing-user'`,
    ).first<{ enabled: number }>();
    expect(row?.enabled).toBe(1);
  });
});
