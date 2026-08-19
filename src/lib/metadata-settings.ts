import type { AppEnv } from "../types";
import { validatePostTemplate } from "./post-template";
import {
  createSubscription,
  deleteSubscription,
  getChannelInformation,
  listSubscriptions,
  TwitchError,
} from "./twitch";
import {
  CHANNEL_UPDATE,
  DEFAULT_CATEGORY_CHANGE_TEMPLATE,
  DEFAULT_COMBINED_CHANGE_TEMPLATE,
  DEFAULT_TITLE_CHANGE_TEMPLATE,
  SETTING_COLUMNS,
  toMetadataSetting,
  type ChannelMetadata,
  type MetadataChangeAction,
  type MetadataSettingRow,
  type MetadataSharingSetting,
} from "./metadata-types";

export async function listMetadataSharingSettings(env: AppEnv, userId: string): Promise<MetadataSharingSetting[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${SETTING_COLUMNS} FROM connections WHERE user_id = ? ORDER BY created_at ASC`,
  ).bind(userId).all<MetadataSettingRow>();
  return results.map(toMetadataSetting);
}

export async function getMetadataSharingSetting(env: AppEnv, connectionId: number): Promise<MetadataSharingSetting | null> {
  const row = await env.DB.prepare(`SELECT ${SETTING_COLUMNS} FROM connections WHERE id = ?`)
    .bind(connectionId).first<MetadataSettingRow>();
  return row ? toMetadataSetting(row) : null;
}

export async function saveMetadataSharingSetting(
  env: AppEnv,
  userId: string,
  connectionId: number,
  input: {
    titleChangeAction: MetadataChangeAction;
    categoryChangeAction: MetadataChangeAction;
    metadataCoalesceEnabled: boolean;
    metadataCoalesceMinutes: number;
    titleChangeTemplate: string;
    categoryChangeTemplate: string;
    combinedChangeTemplate: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE connections SET
       title_change_action = ?, category_change_action = ?,
       metadata_coalesce_enabled = ?, metadata_coalesce_minutes = ?,
       title_change_template = ?, category_change_template = ?, combined_change_template = ?
     WHERE id = ? AND user_id = ?`,
  ).bind(
    input.titleChangeAction,
    input.categoryChangeAction,
    input.metadataCoalesceEnabled ? 1 : 0,
    input.metadataCoalesceMinutes,
    input.titleChangeTemplate || DEFAULT_TITLE_CHANGE_TEMPLATE,
    input.categoryChangeTemplate || DEFAULT_CATEGORY_CHANGE_TEMPLATE,
    input.combinedChangeTemplate || DEFAULT_COMBINED_CHANGE_TEMPLATE,
    connectionId,
    userId,
  ).run();
  return result.meta.changes > 0;
}

export function validateMetadataTemplates(input: {
  titleChangeTemplate: string;
  categoryChangeTemplate: string;
  combinedChangeTemplate: string;
}): string | null {
  for (const [label, template] of [
    ["タイトル変更", input.titleChangeTemplate],
    ["カテゴリ変更", input.categoryChangeTemplate],
    ["タイトル＋カテゴリ変更", input.combinedChangeTemplate],
  ] as const) {
    const error = validatePostTemplate(template);
    if (error) return `${label}: ${error}`;
  }
  return null;
}

export async function getChannelMetadata(env: AppEnv, channelId: string): Promise<ChannelMetadata | null> {
  return env.DB.prepare(`SELECT title, category FROM channel_metadata WHERE twitch_channel_id = ?`)
    .bind(channelId).first<ChannelMetadata>();
}

export async function putChannelMetadata(env: AppEnv, channelId: string, metadata: ChannelMetadata): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO channel_metadata (twitch_channel_id, title, category, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (twitch_channel_id) DO UPDATE SET
       title = excluded.title, category = excluded.category, updated_at = excluded.updated_at`,
  ).bind(channelId, metadata.title, metadata.category).run();
}

export async function seedChannelMetadata(env: AppEnv, channelId: string): Promise<void> {
  const info = await getChannelInformation(env, channelId);
  if (info) await putChannelMetadata(env, channelId, { title: info.title, category: info.gameName });
}

export async function ensureChannelUpdateSubscription(
  env: AppEnv,
  channelId: string,
  callback: string,
  secret: string,
): Promise<void> {
  const existing = await listSubscriptions(env);
  if (existing.some((sub) => sub.type === CHANNEL_UPDATE && sub.condition.broadcaster_user_id === channelId)) return;
  try {
    await createSubscription(env, {
      type: CHANNEL_UPDATE,
      version: "2",
      condition: { broadcaster_user_id: channelId },
      callback,
      secret,
    });
  } catch (err) {
    if (err instanceof TwitchError && err.status === 409) return;
    throw err;
  }
}

export async function removeChannelUpdateSubscription(env: AppEnv, channelId: string): Promise<void> {
  const existing = await listSubscriptions(env);
  for (const sub of existing) {
    if (sub.type === CHANNEL_UPDATE && sub.condition.broadcaster_user_id === channelId) {
      await deleteSubscription(env, sub.id);
    }
  }
}
