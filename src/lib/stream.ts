import type { AppEnv } from "../types";

export interface StreamEvent {
  id?: string;
  type: "stream.online" | "stream.offline";
  broadcasterUserId: string;
  startedAt?: string;
}

export async function processStreamEvent(
  env: AppEnv,
  event: StreamEvent,
): Promise<void> {
  // issue #5 で実装(状態遷移 + Bluesky 反映)
  console.log("processStreamEvent", JSON.stringify(event));
}
