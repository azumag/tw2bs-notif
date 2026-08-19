import type { AppEnv } from "../types";
import { WEBHOOK_SECRET_KEY } from "./eventsub";
import { logError, logInfo } from "./logger";
import { getSession } from "./session";
import {
  ensureChannelUpdateSubscription,
  getMetadataSharingSetting,
  saveMetadataSharingSetting,
  seedChannelMetadata,
  validateMetadataTemplates,
} from "./metadata-settings";
import { isMetadataChangeAction } from "./metadata-types";
import { METADATA_SETTINGS_PATH } from "./metadata-ui";

export async function saveMetadataSettings(request: Request, env: AppEnv): Promise<Response> {
  const session = await getSession(env, request);
  const form = await request.formData().catch(() => null);
  const csrf = typeof form?.get("csrf") === "string" ? form.get("csrf") : null;
  const idRaw = form?.get("connection_id");
  const connectionId = typeof idRaw === "string" ? Number(idRaw) : NaN;
  if (!session || csrf !== session.csrf || !Number.isSafeInteger(connectionId) || connectionId <= 0) return new Response("invalid request", { status: 400 });
  const setting = await getMetadataSharingSetting(env, connectionId);
  if (!setting || setting.userId !== session.twitchUserId) return new Response("not found", { status: 404 });

  const titleAction = form?.get("title_change_action");
  const categoryAction = form?.get("category_change_action");
  const minutesRaw = form?.get("metadata_coalesce_minutes");
  const minutes = typeof minutesRaw === "string" ? Number(minutesRaw) : NaN;
  if (!isMetadataChangeAction(titleAction) || !isMetadataChangeAction(categoryAction) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60) {
    return new Response("invalid metadata settings", { status: 400 });
  }
  const titleChangeTemplate = typeof form?.get("title_change_template") === "string" ? String(form.get("title_change_template")).trim() : "";
  const categoryChangeTemplate = typeof form?.get("category_change_template") === "string" ? String(form.get("category_change_template")).trim() : "";
  const combinedChangeTemplate = typeof form?.get("combined_change_template") === "string" ? String(form.get("combined_change_template")).trim() : "";
  const templateError = validateMetadataTemplates({ titleChangeTemplate, categoryChangeTemplate, combinedChangeTemplate });
  if (templateError) return new Response(templateError, { status: 400 });

  const enabled = titleAction !== "off" || categoryAction !== "off";
  if (enabled) await seedChannelMetadata(env, setting.twitchChannelId).catch((err) => logError("settings", "metadata baseline seed failed", err, { connectionId }));
  const updated = await saveMetadataSharingSetting(env, session.twitchUserId, connectionId, {
    titleChangeAction: titleAction,
    categoryChangeAction: categoryAction,
    metadataCoalesceEnabled: form?.get("metadata_coalesce_enabled") === "1",
    metadataCoalesceMinutes: minutes,
    titleChangeTemplate,
    categoryChangeTemplate,
    combinedChangeTemplate,
  });
  if (!updated) return new Response("not found", { status: 404 });
  if (enabled) {
    const secret = await env.STATE.get(WEBHOOK_SECRET_KEY);
    if (secret) await ensureChannelUpdateSubscription(env, setting.twitchChannelId, env.EVENTSUB_CALLBACK_URL, secret)
      .catch((err) => logError("settings", "channel.update subscription ensure failed", err, { connectionId }));
  }
  logInfo("settings", "updated metadata sharing preference", { connectionId, titleAction, categoryAction, minutes });
  return new Response(null, { status: 302, headers: { Location: `${METADATA_SETTINGS_PATH}?saved=1#metadata-${connectionId}` } });
}

export async function rememberDisconnectedChannel(request: Request, env: AppEnv): Promise<string | null> {
  const session = await getSession(env, request);
  if (!session) return null;
  const form = await request.clone().formData().catch(() => null);
  if (form?.get("csrf") !== session.csrf) return null;
  const idRaw = form?.get("connection_id");
  const id = typeof idRaw === "string" ? Number(idRaw) : NaN;
  if (!Number.isSafeInteger(id)) return null;
  const setting = await getMetadataSharingSetting(env, id);
  return setting?.userId === session.twitchUserId ? setting.twitchChannelId : null;
}
