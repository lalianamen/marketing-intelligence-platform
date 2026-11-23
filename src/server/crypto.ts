import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// AES-256-GCM envelope for provider credentials (OAuth refresh tokens).
// Key: TOKEN_ENCRYPTION_KEY = base64 of 32 random bytes. Rotating keys:
// bump key_version and keep the old key available until rows are re-encrypted.

const VERSION = "v1";

function keyFrom(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes");
  return key;
}

export function encryptSecret(plaintext: string, keyB64: string, aad = ""): string {
  const key = keyFrom(keyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(envelope: string, keyB64: string, aad = ""): string {
  const [version, ivB64, tagB64, ctB64] = envelope.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("Unsupported secret envelope");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(keyB64), Buffer.from(ivB64, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Redact anything that looks like a credential before it reaches logs or the DB. */
export function redact(message: string): string {
  return message
    .replace(/(ya29\.[A-Za-z0-9._-]+)/g, "[redacted-token]")
    .replace(/(1\/\/[A-Za-z0-9._-]{20,})/g, "[redacted-token]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/("?(?:access_token|refresh_token|client_secret|private_key)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]")
    .slice(0, 2000);
}
