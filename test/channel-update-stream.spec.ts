import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/types";
import { processMetadataQueueMessage } from "../src/lib/metadata-processing";
import type { MetadataPostQueueMessage } from "../src/lib/metadata-types";
import { migrations } from "./migrations";

vi.mock("../src/lib/bluesky", () => ({
  createStreamPost: vi.fn(async () => {}),
  setLiveStatus: vi.fn(async () => {}),
  getSessionForUser: vi.fn(async () => ({ did: "did:plc:test", fetchHandler: async () => new Response() })),
}));
const bluesky = await import("../src/lib/bluesky");

function makeEnv(send?: ReturnType<typeof vi.fn>): AppEnv {
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
    EVENTS: send ? ({ send } as unknown as Queue<unknown>) : env.EVENTS,
  } as AppEnv;
}

beforeAll(async () => { await applyD1Migrations(env.DB, migrations as D1Migration[]); });
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM pending_metadata_posts").run();
  await env.DB.prepare("DELETE FROM channel_metadata").run();
  await env.DB.prepare("DELETE FROM live_streams").run();
  await env.DB.prepare("DELETE FROM connections").run();
  await env.STATE.delete("twitch:token");
  vi.mocked(bluesky.createStreamPost).mockReset();
  vi.mocked(bluesky.setLiveStatus).mockReset();
});

function mockTwitch(title = "New title", category = "Games") {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("oauth2/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600, token_type: "bearer" }), { headers: { "Content-Type": "application/json" } });
    if (url.includes("helix/streams?user_id=12345")) return new Response(JSON.stringify({ data: [{ id: "stream-1", user_id: "12345", user_login: "azumagbanjo", started_at: "2026-08-19T00:00:00Z", title, game_name: category, thumbnail_url: "https://example.com/{width}x{height}.jpg" }] }), { headers: { "Content-Type": "application/json" } });
    throw new Error(`unexpected request: ${url}`);
  }));
}

async function setup(env0: AppEnv, coalesce: boolean) {
  const inserted = await env0.DB.prepare(`INSERT INTO connections (user_id, twitch_channel_id, twitch_login, twitch_display_name, title_change_action, category_change_action, metadata_coalesce_enabled, metadata_coalesce_minutes) VALUES ('user-1','12345','azumagbanjo','あずまぐ','status_and_post','status_and_post',?,2)`).bind(coalesce ? 1 : 0).run();
  await env0.DB.prepare(`INSERT INTO live_streams (twitch_channel_id, stream_id, started_at) VALUES ('12345','stream-1','2026-08-19T00:00:00Z')`).run();
  await env0.DB.prepare(`INSERT INTO channel_metadata (twitch_channel_id, title, category) VALUES ('12345','Old title','Music')`).run();
  return Number(inserted.meta.last_row_id);
}

describe("channel.update sharing", () => {
  it("statusを即時更新し、coalesce OFFなら通常ポストも即時作成する", async () => {
    const env0 = makeEnv(vi.fn(async () => {}));
    await setup(env0, false);
    mockTwitch();
    await processMetadataQueueMessage(env0, { type: "channel.update", broadcasterUserId: "12345", broadcasterUserLogin: "azumagbanjo", title: "New title", category: "Games" });
    expect(bluesky.setLiveStatus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "New title", description: "Games" }));
    expect(bluesky.createStreamPost).toHaveBeenCalledTimes(1);
  });

  it("N分以内の連続変更は古いtokenを無効化して1ポストにまとめる", async () => {
    const send = vi.fn(async () => {});
    const env0 = makeEnv(send);
    await setup(env0, true);
    mockTwitch();
    await processMetadataQueueMessage(env0, { type: "channel.update", broadcasterUserId: "12345", title: "New title", category: "Music" });
    await processMetadataQueueMessage(env0, { type: "channel.update", broadcasterUserId: "12345", title: "New title", category: "Games" });
    const messages = send.mock.calls.map((call) => call[0] as MetadataPostQueueMessage);
    expect(messages).toHaveLength(2);
    await processMetadataQueueMessage(env0, messages[0]);
    expect(bluesky.createStreamPost).not.toHaveBeenCalled();
    await processMetadataQueueMessage(env0, messages[1]);
    expect(bluesky.createStreamPost).toHaveBeenCalledTimes(1);
  });

  it("status_onlyならステータスだけ更新して通常ポストしない", async () => {
    const env0 = makeEnv(vi.fn(async () => {}));
    const connectionId = await setup(env0, false);
    await env0.DB.prepare(`UPDATE connections SET title_change_action = 'status_only', category_change_action = 'off' WHERE id = ?`).bind(connectionId).run();
    mockTwitch();
    await processMetadataQueueMessage(env0, { type: "channel.update", broadcasterUserId: "12345", title: "Status only", category: "Music" });
    expect(bluesky.setLiveStatus).toHaveBeenCalledTimes(1);
    expect(bluesky.createStreamPost).not.toHaveBeenCalled();
  });

  it("オフライン中の変更は基準値だけ更新して共有しない", async () => {
    const env0 = makeEnv(vi.fn(async () => {}));
    await setup(env0, false);
    await env0.DB.prepare("DELETE FROM live_streams").run();
    await processMetadataQueueMessage(env0, { type: "channel.update", broadcasterUserId: "12345", title: "Offline title", category: "Music" });
    const metadata = await env0.DB.prepare(`SELECT title, category FROM channel_metadata WHERE twitch_channel_id = '12345'`).first<{ title: string; category: string }>();
    expect(metadata).toEqual({ title: "Offline title", category: "Music" });
    expect(bluesky.setLiveStatus).not.toHaveBeenCalled();
    expect(bluesky.createStreamPost).not.toHaveBeenCalled();
  });

});
