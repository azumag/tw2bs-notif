import { NodeOAuthClient } from "@atproto/oauth-client-node";
import { SimpleStoreMemory } from "@atproto-labs/simple-store-memory";
import { createServer } from "node:http";
import { exec } from "node:child_process";

const PORT = 8899;
const scopeArg =
  process.argv[2] ?? "atproto repo:app.bsky.actor.status";
// トンネル経由の公開URL(例: https://xxx.trycloudflare.com)を指定すると、
// 公開クライアントメタデータ方式で動作する
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;

const declaredScope =
  "atproto repo:app.bsky.actor.status repo:app.bsky.feed.post";
const redirectUri = `${BASE}/callback`;
const clientId = `${BASE}/oauth-client-metadata.json`;
const clientMetadata = {
  client_id: clientId,
  application_type: "web",
  client_name: "tw2bs-notif oauth poc",
  client_uri: BASE,
  redirect_uris: [redirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: declaredScope,
  token_endpoint_auth_method: "none",
  dpop_bound_access_tokens: true,
};

const client = new NodeOAuthClient({
  clientMetadata,
  // PoC 用のメモリストア(本番では永続ストア)
  stateStore: new SimpleStoreMemory({ max: 1000 }),
  sessionStore: new SimpleStoreMemory({ max: 1000 }),
  dpopStore: new SimpleStoreMemory({ max: 1000 }),
});

let resolveCallback;
const callbackPromise = new Promise((r) => (resolveCallback = r));
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/callback") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("認可完了。このタブは閉じてOK");
    resolveCallback(url.searchParams);
  } else if (url.pathname === "/oauth-client-metadata.json") {
    // 公開クライアントメタデータ(AS がこの URL から取得する)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(clientMetadata));
  } else {
    res.end("poc server");
  }
});
server.listen(PORT, "127.0.0.1");

const finish = () =>
  new Promise((r) => server.close(r));

try {
  console.log("要求スコープ:", scopeArg);
  const authUrl = await client.authorize("azumag.bsky.social", {
    scope: scopeArg,
  });

  console.log("\n===== ブラウザで開いて認可してください =====");
  console.log(authUrl.toString());
  console.log("=============================================\n");
  exec(`open "${authUrl}"`);

  const params = await Promise.race([
    callbackPromise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("タイムアウト: 認可されませんでした")), 5 * 60 * 1000),
    ),
  ]);

  const { session } = await client.callback(params);
  const did = session.did;
  console.log("\nDID:", did);
  const info = await session.getTokenInfo();
  console.log("付与スコープ:", info.scope);

  // 1. status record 書き込み(期待: 成功)
  const statusRecord = {
    $type: "app.bsky.actor.status",
    status: "app.bsky.actor.status#live",
    createdAt: new Date().toISOString(),
    durationMinutes: 720,
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        $type: "app.bsky.embed.external#external",
        uri: "https://www.twitch.tv/azumagbanjo",
        title: "oauth poc",
        description: "",
      },
    },
  };
  const putRes = await session.fetchHandler("/xrpc/com.atproto.repo.putRecord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.actor.status",
      rkey: "self",
      record: statusRecord,
      swapRecord: null,
    }),
  });
  console.log("\nSTATUS_WRITE:", putRes.status, (await putRes.text().catch(() => "")).slice(0, 200));

  // 2. feed post 作成(スコープ外なら拒否されるはず)
  const postRecord = {
    $type: "app.bsky.feed.post",
    text: "oauth poc test",
    createdAt: new Date().toISOString(),
  };
  const postRes = await session.fetchHandler("/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.feed.post",
      record: postRecord,
    }),
  });
  const postBody = await postRes.text().catch(() => "");
  console.log("POST_WRITE:", postRes.status, postBody.slice(0, 300));

  // 3. クリーンアップ(status record 削除)
  const delRes = await session.fetchHandler("/xrpc/com.atproto.repo.deleteRecord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.actor.status",
      rkey: "self",
    }),
  });
  console.log("CLEANUP_DELETE_STATUS:", delRes.status);
} catch (err) {
  console.error("\n[FAILED]", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await finish();
}
