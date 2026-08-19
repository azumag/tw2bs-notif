export const CHANNEL_UPDATE = "channel.update" as const;
export const METADATA_POST = "metadata.post" as const;
export const MAX_COALESCE_MINUTES = 60;

export type MetadataChangeAction = "off" | "status_only" | "status_and_post";

export interface ChannelUpdateQueueMessage {
  type: typeof CHANNEL_UPDATE;
  broadcasterUserId: string;
  broadcasterUserLogin?: string;
  title: string;
  category: string;
}

export interface MetadataPostQueueMessage {
  type: typeof METADATA_POST;
  connectionId: number;
  token: string;
}

export type MetadataQueueMessage = ChannelUpdateQueueMessage | MetadataPostQueueMessage;

export function isMetadataQueueMessage(value: { type?: string }): value is MetadataQueueMessage {
  return value.type === CHANNEL_UPDATE || value.type === METADATA_POST;
}

export function isMetadataChangeAction(value: unknown): value is MetadataChangeAction {
  return value === "off" || value === "status_only" || value === "status_and_post";
}

export const DEFAULT_TITLE_CHANGE_TEMPLATE = `配信タイトルを変更しました
{title}
{category}`;
export const DEFAULT_CATEGORY_CHANGE_TEMPLATE = `配信カテゴリを変更しました
{title}
{category}`;
export const DEFAULT_COMBINED_CHANGE_TEMPLATE = `配信情報を更新しました
{title}
{category}`;

export interface MetadataSharingSetting {
  id: number;
  userId: string;
  twitchChannelId: string;
  twitchLogin: string;
  twitchDisplayName: string;
  titleChangeAction: MetadataChangeAction;
  categoryChangeAction: MetadataChangeAction;
  metadataCoalesceEnabled: boolean;
  metadataCoalesceMinutes: number;
  titleChangeTemplate: string;
  categoryChangeTemplate: string;
  combinedChangeTemplate: string;
}

export interface MetadataSettingRow {
  id: number;
  userId: string;
  twitchChannelId: string;
  twitchLogin: string;
  twitchDisplayName: string;
  titleChangeAction: string;
  categoryChangeAction: string;
  metadataCoalesceEnabled: number;
  metadataCoalesceMinutes: number;
  titleChangeTemplate: string;
  categoryChangeTemplate: string;
  combinedChangeTemplate: string;
}

export const SETTING_COLUMNS = `id, user_id AS userId,
  twitch_channel_id AS twitchChannelId, twitch_login AS twitchLogin,
  twitch_display_name AS twitchDisplayName,
  title_change_action AS titleChangeAction,
  category_change_action AS categoryChangeAction,
  metadata_coalesce_enabled AS metadataCoalesceEnabled,
  metadata_coalesce_minutes AS metadataCoalesceMinutes,
  title_change_template AS titleChangeTemplate,
  category_change_template AS categoryChangeTemplate,
  combined_change_template AS combinedChangeTemplate`;

export function toMetadataSetting(row: MetadataSettingRow): MetadataSharingSetting {
  return {
    ...row,
    titleChangeAction: isMetadataChangeAction(row.titleChangeAction) ? row.titleChangeAction : "off",
    categoryChangeAction: isMetadataChangeAction(row.categoryChangeAction) ? row.categoryChangeAction : "off",
    metadataCoalesceEnabled: row.metadataCoalesceEnabled !== 0,
  };
}

export interface ChannelMetadata {
  title: string;
  category: string;
}
