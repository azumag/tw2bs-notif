import { NodeOAuthClient } from "@atproto/oauth-client-node";
import { SimpleStoreMemory } from "@atproto-labs/simple-store-memory";

const client = new NodeOAuthClient({
  clientMetadata: {
    client_id:
      "http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A8899%2Fcallback&scope=atproto%20repo%3Aapp.bsky.actor.status%20repo%3Aapp.bsky.feed.post",
    client_name: "oauth-debug",
    redirect_uris: ["http://127.0.0.1:8899/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "atproto repo:app.bsky.actor.status repo:app.bsky.feed.post",
    token_endpoint_auth_method: "none",
    dpop_bound_access_tokens: true,
  },
  stateStore: new SimpleStoreMemory({ max: 100 }),
  sessionStore: new SimpleStoreMemory({ max: 100 }),
  dpopStore: new SimpleStoreMemory({ max: 100 }),
});

const input = process.argv[2] ?? "https://bsky.social";
try {
  const url = await client.authorize(input, {
    scope: "atproto repo:app.bsky.actor.status repo:app.bsky.feed.post",
    prompt: "select_account",
  });
  console.log("OK:", url.toString().slice(0, 200));
} catch (err) {
  console.error("FAIL:", err?.message ?? err);
  if (err?.response) {
    console.error("HTTP", err.response.status, (await err.response.text().catch(() => "")).slice(0, 300));
  }
  process.exit(1);
}
