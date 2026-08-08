import type { AppEnv } from "../types";

/**
 * AES-256-GCM による暗号化ヘルパー。
 * ENCRYPTION_KEY(32バイト hex)から鍵を導出し、暗号化する。
 * 形式: v1:<base64(iv)>:<base64(ciphertext)>
 */

const encoder = new TextEncoder();

async function getKey(env: AppEnv): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  const hex = env.ENCRYPTION_KEY;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes hex (64 hex chars)");
  }
  for (let i = 0; i < 32; i++) {
    raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export async function encryptSecret(
  env: AppEnv,
  plaintext: string,
): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return `v1:${toB64(iv)}:${toB64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(
  env: AppEnv,
  payload: string,
): Promise<string> {
  const parts = payload.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("invalid encrypted payload format");
  }
  const key = await getKey(env);
  const iv = fromB64(parts[1]);
  const ciphertext = fromB64(parts[2]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
