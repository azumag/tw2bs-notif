import { EVENTSUB_PATH, handleEventSub } from "./lib/eventsub";
import type { AppEnv } from "./types";

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === EVENTSUB_PATH) {
      return handleEventSub(request, env, ctx);
    }
    if (request.method === "GET") {
      return new Response("tw2bs-notif is running", { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<AppEnv>;
