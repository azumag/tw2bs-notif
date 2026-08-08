export interface TwitchSecrets {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_BROADCASTER_ID: string;
}

export interface BlueskySecrets {
  BSKY_HANDLE: string;
  BSKY_APP_PASSWORD: string;
}

export interface FeatureVars {
  /** "true" のとき配信開始時に Bluesky へ通常投稿も作成する */
  BSKY_POST_ON_START?: string;
}

export type AppEnv = Env & TwitchSecrets & BlueskySecrets & FeatureVars;

export const STREAM_ONLINE = "stream.online";
export const STREAM_OFFLINE = "stream.offline";
