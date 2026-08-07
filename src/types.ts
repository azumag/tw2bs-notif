export interface TwitchSecrets {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_BROADCASTER_ID: string;
}

export type AppEnv = Env & TwitchSecrets;

export const STREAM_ONLINE = "stream.online";
export const STREAM_OFFLINE = "stream.offline";
