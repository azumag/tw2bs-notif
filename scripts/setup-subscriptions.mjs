#!/usr/bin/env node
/**
 * EventSub subscription セットアップスクリプト
 *
 * 使い方:
 *   npm run setup            # webhook secret を KV に保存し stream.online/offline を購読
 *   npm run setup -- list    # 現在の購読一覧を表示
 *   npm run setup -- delete <subscription-id>   # 購読を削除
 *
 * setup 時に必要な環境変数:
 *   TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET / TWITCH_BROADCASTER_ID
 *   CALLBACK_URL (例: https://tw2bs-notif.<account>.workers.dev/twitch/eventsub)
 *   任意: WEBHOOK_SECRET (指定がなければ KV の既存値 or ランダム生成)
 *
 * list / delete は CALLBACK_URL 不要。
 * 前提: wrangler.jsonc の KV id が実値で設定済み(wrangler ログイン済み)であること
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const TWITCH_API = "https://api.twitch.tv/helix";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const WEBHOOK_SECRET_KEY = "twitch:webhook_secret";

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`環境変数 ${name} が設定されていません`);
    process.exit(1);
  }
  return process.env[name];
}

const clientId = requireEnv("TWITCH_CLIENT_ID");
const clientSecret = requireEnv("TWITCH_CLIENT_SECRET");
const broadcasterId = requireEnv("TWITCH_BROADCASTER_ID");

const args = process.argv.slice(2);
const mode = args[0] ?? "setup";

let callback;
if (mode === "setup") {
  callback = requireEnv("CALLBACK_URL");
  if (!callback.startsWith("https://")) {
    console.error("CALLBACK_URL は https:// で始まる必要があります(Twitch は HTTPS のみ許可)");
    process.exit(1);
  }
}

async function getAppToken() {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const res = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`トークン取得失敗: HTTP ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function api(path, init, token) {
  const res = await fetch(`${TWITCH_API}${path}`, {
    ...init,
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Twitch API エラー: HTTP ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? {} : res.json();
}

function wrangler(argsList, { allowFailure = false } = {}) {
  try {
    return execFileSync("npx", ["wrangler", ...argsList], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (allowFailure) return "";
    // コマンド全文に secret が含まれる可能性があるため、メッセージは秘匿する
    throw new Error(
      `wrangler の実行に失敗しました(引数: ${argsList[0]} ${argsList[1]})。` +
        "KV namespace の id が wrangler.jsonc に実値で設定されているか、`wrangler login` 済みか確認してください。",
    );
  }
}

function kvGet(key) {
  const out = wrangler(["kv", "key", "get", key, "--binding", "STATE"], {
    allowFailure: true,
  });
  return out.trim() || null;
}

function kvPut(key, value) {
  const out = wrangler(["kv", "key", "put", key, value, "--binding", "STATE"]);
  console.log("  " + out.trim().split("\n").at(-1));
}

function getOrCreateWebhookSecret() {
  if (process.env.WEBHOOK_SECRET) {
    return process.env.WEBHOOK_SECRET;
  }
  const existing = kvGet(WEBHOOK_SECRET_KEY);
  if (existing) {
    console.log(`既存の webhook secret を再利用します(KV の ${WEBHOOK_SECRET_KEY})`);
    return existing;
  }
  const generated = randomBytes(32).toString("hex");
  console.log("webhook secret を新規生成します");
  return generated;
}

async function listSubscriptions(token) {
  return api("/eventsub/subscriptions", {}, token);
}

async function ensureSubscription(token, type, version, condition, secret) {
  const existing = await listSubscriptions(token);
  const match = existing.data.find(
    (s) =>
      s.type === type && s.condition.broadcaster_user_id === broadcasterId,
  );
  if (match) {
    if (match.transport.callback === callback && match.status === "enabled") {
      console.log(`[skip] ${type} は既に購読済み (id: ${match.id}, status: ${match.status})`);
      return;
    }
    // callback URL 変更や無効状態: 作り直す
    console.log(`[replace] ${type} の既存購読(id: ${match.id})を再作成します`);
    await api(
      `/eventsub/subscriptions?id=${encodeURIComponent(match.id)}`,
      { method: "DELETE" },
      token,
    );
  }
  try {
    const created = await api(
      "/eventsub/subscriptions",
      {
        method: "POST",
        body: JSON.stringify({
          type,
          version,
          condition,
          transport: { method: "webhook", callback, secret },
        }),
      },
      token,
    );
    console.log(`[ok] ${type} を購読しました (id: ${created.data[0].id}, status: ${created.data[0].status})`);
  } catch (err) {
    if (err.status === 409) {
      console.log(`[skip] ${type} は既に存在します (409)`);
      return;
    }
    throw err;
  }
}

async function main() {
  if (mode === "list") {
    const token = await getAppToken();
    const subs = await listSubscriptions(token);
    if (subs.data.length === 0) {
      console.log("購読はありません");
      return;
    }
    for (const s of subs.data) {
      console.log(`${s.id}\t${s.type}\t${s.status}\t${s.transport.callback}`);
    }
    return;
  }

  if (mode === "delete") {
    const id = args[1];
    if (!id) {
      console.error("削除する subscription id を指定してください: npm run setup -- delete <id>");
      process.exit(1);
    }
    const token = await getAppToken();
    await api(`/eventsub/subscriptions?id=${encodeURIComponent(id)}`, { method: "DELETE" }, token);
    console.log(`[ok] ${id} を削除しました`);
    return;
  }

  if (mode !== "setup") {
    console.error(`不明なコマンド: ${mode} (setup | list | delete)`);
    process.exit(1);
  }

  console.log("1/3 webhook secret を準備中...");
  const secret = getOrCreateWebhookSecret();
  console.log("  KV に保存中...");
  kvPut(WEBHOOK_SECRET_KEY, secret);

  console.log("2/3 Twitch アプリトークンを取得中...");
  const token = await getAppToken();

  console.log("3/3 subscription を登録中...");
  await ensureSubscription(token, "stream.online", "1", {
    broadcaster_user_id: broadcasterId,
  }, secret);
  await ensureSubscription(token, "stream.offline", "1", {
    broadcaster_user_id: broadcasterId,
  }, secret);
  console.log("完了。Twitch コンソール(dev.twitch.tv)でも確認できます。");
}

main().catch((err) => {
  console.error("失敗:", err.message);
  process.exit(1);
});
