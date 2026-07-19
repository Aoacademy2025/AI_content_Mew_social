import crypto from "node:crypto";

// BYOK provider-key encryption at rest.
//
// Historically "encryption" here was just base64 (NOT encryption — reversible by
// anyone). This module upgrades new writes to AES-256-GCM while staying fully
// backward compatible with the base64 values already in the DB, so deploy carries
// ZERO migration risk: reads keep working before and after the one-time re-encrypt
// migration (scripts/encrypt-existing-keys.ts).
//
// Stored format for encrypted values (self-identifying):
//   v2:<ivB64>:<tagB64>:<ciphertextB64>
// Anything without the "v2:" prefix is treated as a LEGACY base64 value.
//
// The AES key is derived from process.env.KEY_ENC_SECRET via SHA-256 (→ 32 bytes).
// If KEY_ENC_SECRET is unset we log a loud warning and degrade to legacy base64 in
// BOTH directions — i.e. today's behavior — so a missing env var never throws.

const PREFIX = "v2:";

let warnedMissingSecret = false;
function warnMissingSecret() {
  if (warnedMissingSecret) return;
  warnedMissingSecret = true;
  console.error(
    "\n****************************************************************\n" +
      "[key-crypto] WARNING: KEY_ENC_SECRET is NOT set.\n" +
      "BYOK provider API keys are being stored as UNENCRYPTED base64\n" +
      "(reversible plaintext — NOT encrypted at rest). Set KEY_ENC_SECRET\n" +
      "in the environment to enable AES-256-GCM encryption, then run\n" +
      "scripts/encrypt-existing-keys.ts to migrate existing rows.\n" +
      "****************************************************************\n",
  );
}

function getSecret(): string | null {
  const s = process.env.KEY_ENC_SECRET;
  return s && s.length > 0 ? s : null;
}

function deriveKey(secret: string): Buffer {
  // SHA-256 of the secret → deterministic 32-byte key for AES-256.
  return crypto.createHash("sha256").update(secret, "utf-8").digest();
}

function legacyEncode(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function legacyDecode(stored: string): string {
  return Buffer.from(stored, "base64").toString("utf-8");
}

/**
 * Encrypt a plaintext provider key for storage.
 * - With KEY_ENC_SECRET set: AES-256-GCM, returned as `v2:<iv>:<tag>:<ct>`.
 * - Without it: warns loudly and falls back to legacy base64 (today's behavior).
 * The input is trimmed first — pasted keys often carry a trailing newline/spaces
 * that break provider auth (matches the previous inline behavior).
 */
export function encryptKey(plain: string): string {
  const text = (plain ?? "").trim();
  const secret = getSecret();
  if (!secret) {
    warnMissingSecret();
    return legacyEncode(text);
  }
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12); // 96-bit nonce, recommended for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt a stored provider key.
 * - `v2:` prefix → AES-256-GCM (requires KEY_ENC_SECRET).
 * - anything else → LEGACY base64 (existing DB values).
 * Never throws: on a missing secret it warns and treats input as base64; on a
 * corrupt/wrong-secret v2 value it logs and returns "" (callers then behave as if
 * the key is unset — an auth failure downstream, not a 500).
 */
export function decryptKey(stored: string): string {
  if (!stored) return "";
  const secret = getSecret();

  if (stored.startsWith(PREFIX)) {
    if (!secret) {
      // Can't AES-decrypt without the secret. Degrade gracefully (never throw).
      warnMissingSecret();
      return "";
    }
    try {
      const parts = stored.split(":"); // ["v2", ivB64, tagB64, ctB64] — base64 never contains ":"
      const ivB64 = parts[1];
      const tagB64 = parts[2];
      const ctB64 = parts[3];
      if (!ivB64 || !tagB64 || !ctB64) return "";
      const key = deriveKey(secret);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
      return pt.toString("utf-8");
    } catch (e) {
      console.error("[key-crypto] failed to decrypt v2 key (wrong KEY_ENC_SECRET or corrupt value):", (e as Error).message);
      return "";
    }
  }

  // Legacy base64 value (present before this migration, or written while the
  // secret was unset). Decodes identically to the old inline behavior.
  if (!secret) warnMissingSecret();
  return legacyDecode(stored);
}

/** True for values already upgraded to AES-256-GCM (`v2:` prefix). */
export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(PREFIX);
}
