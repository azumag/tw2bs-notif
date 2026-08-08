import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/types";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";

function makeEnv(encryptionKey?: string): AppEnv {
  return {
    ...env,
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    TWITCH_BROADCASTER_ID: "12345",
    BSKY_HANDLE: "test.bsky.social",
    BSKY_APP_PASSWORD: "test-app-password",
    ENCRYPTION_KEY:
      encryptionKey ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    TWITCH_OAUTH_REDIRECT_URL: env.TWITCH_OAUTH_REDIRECT_URL,
  } as AppEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", async () => {
    const e = makeEnv();
    const enc = await encryptSecret(e, "my-secret-value");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("my-secret-value");
    await expect(decryptSecret(e, enc)).resolves.toBe("my-secret-value");
  });

  it("produces different ciphertexts for the same plaintext (random IV)", async () => {
    const e = makeEnv();
    const a = await encryptSecret(e, "same");
    const b = await encryptSecret(e, "same");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with a different key", async () => {
    const e1 = makeEnv();
    const e2 = makeEnv("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    const enc = await encryptSecret(e1, "secret");
    await expect(decryptSecret(e2, enc)).rejects.toThrow();
  });

  it("fails on tampered ciphertext", async () => {
    const e = makeEnv();
    const enc = await encryptSecret(e, "secret");
    const parts = enc.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2].slice(0, -2)}xx`;
    await expect(decryptSecret(e, tampered)).rejects.toThrow();
  });

  it("rejects a malformed payload", async () => {
    await expect(decryptSecret(makeEnv(), "not-a-payload")).rejects.toThrow(
      "invalid encrypted payload format",
    );
  });

  it("rejects a non-64-char encryption key", async () => {
    const e = makeEnv("abcd");
    await expect(encryptSecret(e, "x")).rejects.toThrow(
      "ENCRYPTION_KEY must be 32 bytes hex",
    );
  });

  it("rejects a 64-char key with non-hex characters", async () => {
    const e = makeEnv("gg".repeat(32));
    await expect(encryptSecret(e, "x")).rejects.toThrow(
      "ENCRYPTION_KEY must be 32 bytes hex",
    );
  });
});
