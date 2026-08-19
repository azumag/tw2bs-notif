import baseWorker from "./index";
import type { AppEnv } from "./types";
import { EVENTSUB_PATH } from "./lib/eventsub";
import { logError } from "./lib/logger";
import { handleChannelUpdateEventSub } from "./lib/metadata-eventsub";
import { processMetadataQueueMessage } from "./lib/metadata-processing";
import { isMetadataQueueMessage, type MetadataQueueMessage } from "./lib/metadata-types";
import {
  rememberDisconnectedChannel,
  saveMetadataSettings,
} from "./lib/metadata-routes";
import {
  METADATA_SETTINGS_PATH,
  decorateChannelsResponse,
  renderMetadataSettings,
} from "./lib/metadata-ui";
import { removeChannelUpdateSubscription } from "./lib/metadata-settings";
import {
  isStreamRenewal,
  processStreamEvent,
  processStreamRenewals,
  type QueueMessage,
  type StreamRenewal,
} from "./lib/stream";

const CHANNELS_PATH = "/channels";
const DISCONNECT_PATH = "/channels/disconnect";
type WorkerQueueMessage = QueueMessage | MetadataQueueMessage;

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === EVENTSUB_PATH) {
      const metadataResponse = await handleChannelUpdateEventSub(request, env, ctx);
      if (metadataResponse) return metadataResponse;
    }
    if (url.pathname === METADATA_SETTINGS_PATH && request.method === "GET") return renderMetadataSettings(request, env);
    if (url.pathname === METADATA_SETTINGS_PATH && request.method === "POST") return saveMetadataSettings(request, env);

    const disconnectedChannel = url.pathname === DISCONNECT_PATH && request.method === "POST"
      ? await rememberDisconnectedChannel(request, env)
      : null;
    const response = await baseWorker.fetch(request, env, ctx);
    if (disconnectedChannel && response.status >= 300 && response.status < 400) {
      ctx.waitUntil(removeChannelUpdateSubscription(env, disconnectedChannel).catch((err) =>
        logError("channels", "remove channel.update failed", err, { channelId: disconnectedChannel }),
      ));
    }
    if (url.pathname === CHANNELS_PATH && request.method === "GET") return decorateChannelsResponse(response);
    return response;
  },

  async queue(batch: MessageBatch<WorkerQueueMessage>, env: AppEnv): Promise<void> {
    const renewals: StreamRenewal[] = [];
    for (const message of batch.messages) {
      const body = message.body;
      if (isMetadataQueueMessage(body)) await processMetadataQueueMessage(env, body);
      else if (isStreamRenewal(body)) renewals.push(body);
      else await processStreamEvent(env, body);
    }
    await processStreamRenewals(env, renewals);
  },
} satisfies ExportedHandler<AppEnv, WorkerQueueMessage>;
