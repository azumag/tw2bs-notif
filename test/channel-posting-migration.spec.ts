import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_POST_TEMPLATE } from "../src/lib/post-template";
import { migrations } from "./migrations";

describe("0007_channel-posting migration", () => {
  it("既存連携へユーザー設定と既定フォーマットを引き継ぐ", async () => {
    await applyD1Migrations(env.DB, migrations.slice(0, 6) as D1Migration[]);
    await env.DB.prepare(
      `INSERT INTO users
         (twitch_user_id, twitch_username, twitch_display_name, bsky_post_on_start)
       VALUES ('existing-user', 'existing', '既存ユーザー', 0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO connections
         (user_id, twitch_channel_id, twitch_login, twitch_display_name)
       VALUES ('existing-user', 'channel-1', 'channel_one', 'チャンネル1')`,
    ).run();

    await applyD1Migrations(env.DB, migrations.slice(6) as D1Migration[]);

    const row = await env.DB.prepare(
      `SELECT post_on_start AS postOnStart, post_template AS postTemplate,
              post_include_title AS includeTitle,
              post_include_category AS includeCategory
       FROM connections WHERE twitch_channel_id = 'channel-1'`,
    ).first<{
      postOnStart: number;
      postTemplate: string;
      includeTitle: number;
      includeCategory: number;
    }>();
    expect(row).toEqual({
      postOnStart: 0,
      postTemplate: DEFAULT_POST_TEMPLATE,
      includeTitle: 1,
      includeCategory: 0,
    });
  });
});
