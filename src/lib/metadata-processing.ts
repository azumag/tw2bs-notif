import type { AppEnv } from "../types";
import { createStreamPost, getSessionForUser, setLiveStatus } from "./bluesky";
import { logError } from "./logger";
import { formatStreamPostText } from "./post-template";
import { getStreamState } from "./twitch";
import {
  getChannelMetadata,
  getMetadataSharingSetting,
  putChannelMetadata,
} from "./metadata-settings";
import {
  MAX_COALESCE_MINUTES,
  METADATA_POST,
  SETTING_COLUMNS,
  toMetadataSetting,
  type ChannelMetadata,
  type ChannelUpdateQueueMessage,
  type MetadataPostQueueMessage,
  type MetadataQueueMessage,
  type MetadataSettingRow,
  type MetadataSharingSetting,
} from "./metadata-types";

const THUMB_WIDTH = 640;
const THUMB_HEIGHT = 360;

function twitchUrl(login: string): string { return `https://www.twitch.tv/${login}`; }
function thumbnailUrl(raw?: string): string | undefined {
  return raw?.replace("{width}", String(THUMB_WIDTH)).replace("{height}", String(THUMB_HEIGHT));
}

async function representativeChannelId(env: AppEnv, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT c.twitch_channel_id AS channelId
     FROM connections c JOIN live_streams ls ON ls.twitch_channel_id = c.twitch_channel_id
     WHERE c.user_id = ?
     ORDER BY (ls.started_at IS NULL) ASC, ls.started_at DESC, c.twitch_channel_id DESC LIMIT 1`,
  ).bind(userId).first<{ channelId: string }>();
  return row?.channelId ?? null;
}

async function refreshStatus(env: AppEnv, setting: MetadataSharingSetting, event: ChannelUpdateQueueMessage): Promise<void> {
  if ((await representativeChannelId(env, setting.userId)) !== setting.twitchChannelId) return;
  const session = await getSessionForUser(env, setting.userId);
  if (!session) return;
  const stream = await getStreamState(env, setting.twitchChannelId).catch(() => null);
  await setLiveStatus(session, {
    uri: twitchUrl(event.broadcasterUserLogin ?? setting.twitchLogin),
    title: event.title,
    description: event.category,
    thumbnailUrl: thumbnailUrl(stream?.thumbnailUrl),
  });
}

function templateFor(setting: MetadataSharingSetting, changes: { titleChanged: boolean; categoryChanged: boolean }): string {
  if (changes.titleChanged && changes.categoryChanged) return setting.combinedChangeTemplate;
  return changes.titleChanged ? setting.titleChangeTemplate : setting.categoryChangeTemplate;
}

async function createMetadataPost(
  env: AppEnv,
  setting: MetadataSharingSetting,
  changes: { titleChanged: boolean; categoryChanged: boolean },
  metadata: ChannelMetadata,
): Promise<void> {
  const session = await getSessionForUser(env, setting.userId);
  if (!session) return;
  const stream = await getStreamState(env, setting.twitchChannelId).catch(() => null);
  const uri = twitchUrl(stream?.userLogin ?? setting.twitchLogin);
  const text = formatStreamPostText(templateFor(setting, changes), {
    title: metadata.title,
    category: metadata.category,
    channel: setting.twitchDisplayName,
    url: uri,
  });
  await createStreamPost(session, {
    uri,
    title: metadata.title,
    description: metadata.category,
    thumbnailUrl: thumbnailUrl(stream?.thumbnailUrl),
    text,
  });
}

async function scheduleMetadataPost(
  env: AppEnv,
  setting: MetadataSharingSetting,
  changes: { titleChanged: boolean; categoryChanged: boolean },
  metadata: ChannelMetadata,
): Promise<void> {
  const token = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO pending_metadata_posts
       (connection_id, token, title_changed, category_changed, title, category, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (connection_id) DO UPDATE SET
       token = excluded.token,
       title_changed = CASE WHEN pending_metadata_posts.title_changed = 1 OR excluded.title_changed = 1 THEN 1 ELSE 0 END,
       category_changed = CASE WHEN pending_metadata_posts.category_changed = 1 OR excluded.category_changed = 1 THEN 1 ELSE 0 END,
       title = excluded.title, category = excluded.category, updated_at = excluded.updated_at`,
  ).bind(
    setting.id,
    token,
    changes.titleChanged ? 1 : 0,
    changes.categoryChanged ? 1 : 0,
    metadata.title,
    metadata.category,
  ).run();
  const minutes = Math.min(MAX_COALESCE_MINUTES, Math.max(1, Math.trunc(setting.metadataCoalesceMinutes || 1)));
  await env.EVENTS.send(
    { type: METADATA_POST, connectionId: setting.id, token } satisfies MetadataPostQueueMessage,
    { delaySeconds: minutes * 60 },
  );
}

async function processChannelUpdate(env: AppEnv, event: ChannelUpdateQueueMessage): Promise<void> {
  const settings = await env.DB.prepare(
    `SELECT ${SETTING_COLUMNS} FROM connections WHERE twitch_channel_id = ?`,
  ).bind(event.broadcasterUserId).all<MetadataSettingRow>().then(({ results }) => results.map(toMetadataSetting));
  if (!settings.length) return;

  const current = { title: event.title, category: event.category };
  const previous = await getChannelMetadata(env, event.broadcasterUserId);
  await putChannelMetadata(env, event.broadcasterUserId, current);
  if (!previous) return;
  const titleChanged = previous.title !== current.title;
  const categoryChanged = previous.category !== current.category;
  if (!titleChanged && !categoryChanged) return;

  const live = await env.DB.prepare(`SELECT twitch_channel_id FROM live_streams WHERE twitch_channel_id = ?`)
    .bind(event.broadcasterUserId).first();
  if (!live) return;

  for (const setting of settings) {
    const statusNeeded =
      (titleChanged && setting.titleChangeAction !== "off") ||
      (categoryChanged && setting.categoryChangeAction !== "off");
    const postTitle = titleChanged && setting.titleChangeAction === "status_and_post";
    const postCategory = categoryChanged && setting.categoryChangeAction === "status_and_post";
    if (statusNeeded) {
      await refreshStatus(env, setting, event).catch((err) =>
        logError("metadata", "status refresh failed", err, { connectionId: setting.id }),
      );
    }
    if (!postTitle && !postCategory) continue;
    try {
      const changes = { titleChanged: postTitle, categoryChanged: postCategory };
      if (setting.metadataCoalesceEnabled) await scheduleMetadataPost(env, setting, changes, current);
      else await createMetadataPost(env, setting, changes, current);
    } catch (err) {
      logError("metadata", "metadata post failed", err, { connectionId: setting.id });
    }
  }
}

interface PendingRow {
  connectionId: number;
  token: string;
  titleChanged: number;
  categoryChanged: number;
  title: string;
  category: string;
}

async function processDelayedMetadataPost(env: AppEnv, message: MetadataPostQueueMessage): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT connection_id AS connectionId, token, title_changed AS titleChanged,
            category_changed AS categoryChanged, title, category
     FROM pending_metadata_posts WHERE connection_id = ? AND token = ?`,
  ).bind(message.connectionId, message.token).first<PendingRow>();
  if (!pending) return;

  const setting = await getMetadataSharingSetting(env, message.connectionId);
  if (!setting) return;
  const live = await env.DB.prepare(`SELECT twitch_channel_id FROM live_streams WHERE twitch_channel_id = ?`)
    .bind(setting.twitchChannelId).first();
  if (!live) {
    await env.DB.prepare(`DELETE FROM pending_metadata_posts WHERE connection_id = ?`).bind(setting.id).run();
    return;
  }

  const titleChanged = pending.titleChanged !== 0 && setting.titleChangeAction === "status_and_post";
  const categoryChanged = pending.categoryChanged !== 0 && setting.categoryChangeAction === "status_and_post";
  if (titleChanged || categoryChanged) {
    const latest = (await getChannelMetadata(env, setting.twitchChannelId)) ?? {
      title: pending.title,
      category: pending.category,
    };
    await createMetadataPost(env, setting, { titleChanged, categoryChanged }, latest);
  }
  await env.DB.prepare(`DELETE FROM pending_metadata_posts WHERE connection_id = ?`).bind(setting.id).run();
}

export async function processMetadataQueueMessage(env: AppEnv, message: MetadataQueueMessage): Promise<void> {
  if (message.type === "channel.update") await processChannelUpdate(env, message);
  else await processDelayedMetadataPost(env, message);
}
