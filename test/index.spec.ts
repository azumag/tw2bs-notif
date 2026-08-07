import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

describe("tw2bs-notif worker", () => {
  it("responds with running message on GET /", async () => {
    const response = await exports.default.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tw2bs-notif is running");
  });

  it("can read and write KV values", async () => {
    await env.STATE.put("test-key", "test-value");
    expect(await env.STATE.get("test-key")).toBe("test-value");
  });
});
