import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const BASE64URL = /^(?:[A-Za-z0-9_-]{2,})?$/u;
const ROOT_SALT_LABEL = "hero-voice-canary/v1/root-salt";

export class HeroVoiceCanaryCanonicalError extends Error {
  constructor() {
    super("Hero Voice canary canonical data is invalid");
    this.name = "HeroVoiceCanaryCanonicalError";
  }
}

function invalid(): never {
  throw new HeroVoiceCanaryCanonicalError();
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) invalid();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** RFC 8785 JCS for JSON-domain values. Invalid Unicode, non-finite numbers,
 * sparse arrays, undefined values, and non-plain objects are rejected. */
export function heroVoiceCanaryJcsBytes(value: unknown): Buffer {
  const encode = (item: unknown): string => {
    if (item === null) return "null";
    if (item === true) return "true";
    if (item === false) return "false";
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid();
      return JSON.stringify(Object.is(item, -0) ? 0 : item);
    }
    if (typeof item === "string") {
      assertUnicodeScalarString(item);
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (Object.keys(item).some((key) => !/^(?:0|[1-9][0-9]*)$/u.test(key))) invalid();
      for (let index = 0; index < item.length; index += 1) {
        if (!(index in item)) invalid();
      }
      return `[${item.map(encode).join(",")}]`;
    }
    if (isRecord(item)) {
      const keys = Object.keys(item).sort();
      return `{${keys.map((key) => {
        assertUnicodeScalarString(key);
        const child = item[key];
        if (child === undefined || typeof child === "bigint" || typeof child === "function"
          || typeof child === "symbol") invalid();
        return `${JSON.stringify(key)}:${encode(child)}`;
      }).join(",")}}`;
    }
    invalid();
  };
  return Buffer.from(encode(value), "utf8");
}

class StrictJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    if (this.source.charCodeAt(0) === 0xfeff) invalid();
    this.whitespace();
    const result = this.value();
    this.whitespace();
    if (this.offset !== this.source.length) invalid();
    return result;
  }

  private whitespace(): void {
    while (this.offset < this.source.length && /[\u0009\u000a\u000d\u0020]/u.test(this.source[this.offset])) {
      this.offset += 1;
    }
  }

  private value(): unknown {
    this.whitespace();
    const token = this.source[this.offset];
    if (token === "{") return this.object();
    if (token === "[") return this.array();
    if (token === '"') return this.string();
    if (token === "t" && this.take("true")) return true;
    if (token === "f" && this.take("false")) return false;
    if (token === "n" && this.take("null")) return null;
    return this.number();
  }

  private take(value: string): boolean {
    if (!this.source.startsWith(value, this.offset)) invalid();
    this.offset += value.length;
    return true;
  }

  private object(): Record<string, unknown> {
    this.offset += 1;
    this.whitespace();
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return output;
    }
    while (true) {
      if (this.source[this.offset] !== '"') invalid();
      const key = this.string();
      if (seen.has(key)) invalid();
      seen.add(key);
      this.whitespace();
      if (this.source[this.offset] !== ":") invalid();
      this.offset += 1;
      output[key] = this.value();
      this.whitespace();
      const separator = this.source[this.offset];
      this.offset += 1;
      if (separator === "}") return output;
      if (separator !== ",") invalid();
      this.whitespace();
    }
  }

  private array(): unknown[] {
    this.offset += 1;
    this.whitespace();
    const output: unknown[] = [];
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return output;
    }
    while (true) {
      output.push(this.value());
      this.whitespace();
      const separator = this.source[this.offset];
      this.offset += 1;
      if (separator === "]") return output;
      if (separator !== ",") invalid();
      this.whitespace();
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.source.length) {
      const code = this.source.charCodeAt(this.offset);
      if (!escaped && code === 0x22) {
        this.offset += 1;
        let parsed: unknown;
        try { parsed = JSON.parse(this.source.slice(start, this.offset)) as unknown; } catch { invalid(); }
        if (typeof parsed !== "string") invalid();
        assertUnicodeScalarString(parsed);
        return parsed;
      }
      if (!escaped && code < 0x20) invalid();
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      this.offset += 1;
    }
    invalid();
  }

  private number(): number {
    const remaining = this.source.slice(this.offset);
    const match = remaining.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) invalid();
    this.offset += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) invalid();
    return parsed;
  }
}

/** UTF-8-fatal, duplicate-key-rejecting JSON parse. */
export function parseHeroVoiceCanaryStrictJson(bytes: Uint8Array): unknown {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { invalid(); }
  return new StrictJsonParser(source).parse();
}

export function assertHeroVoiceCanaryExactJcs(bytes: Uint8Array): unknown {
  const parsed = parseHeroVoiceCanaryStrictJson(bytes);
  const canonical = heroVoiceCanaryJcsBytes(parsed);
  if (!constantTimeBytesEqual(Buffer.from(bytes), canonical)) invalid();
  return parsed;
}

export function heroVoiceCanarySha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function encodeHeroVoiceCanaryBase64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function decodeHeroVoiceCanaryBase64url(value: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(value) || value.includes("=") || value.length % 4 === 1) invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) invalid();
  return decoded;
}

export function assertHeroVoiceCanarySha256(value: string): string {
  if (!HEX_SHA256.test(value)) invalid();
  return value;
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function heroVoiceCanaryHexMatches(left: string, right: string): boolean {
  if (!HEX_SHA256.test(left) || !HEX_SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export type HeroVoiceCanaryKeyPurpose = "reveal" | "score" | "ledger" | "submit";

const KEY_INFO: Record<HeroVoiceCanaryKeyPurpose, string> = {
  reveal: "hero-voice-canary/v1/reveal-aes-256-gcm",
  score: "hero-voice-canary/v1/score-hmac-sha256",
  ledger: "hero-voice-canary/v1/ledger-hmac-sha256",
  submit: "hero-voice-canary/v1/submit-hmac-sha256",
};

export function decodeHeroVoiceCanaryReviewIkm(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) invalid();
  return decodeHeroVoiceCanaryBase64url(encoded, 32);
}

export function deriveHeroVoiceCanaryRunKey(
  ikm: Uint8Array,
  purpose: HeroVoiceCanaryKeyPurpose,
  runId: string,
): Buffer {
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(runId) || Buffer.from(ikm).length !== 32) invalid();
  const salt = createHash("sha256").update(ROOT_SALT_LABEL, "utf8").digest();
  const info = Buffer.concat([Buffer.from(KEY_INFO[purpose], "utf8"), Buffer.from([0]), Buffer.from(runId, "utf8")]);
  return Buffer.from(hkdfSync("sha256", Buffer.from(ikm), salt, info, 32));
}

export function heroVoiceCanaryHmacHex(key: Uint8Array, value: unknown): string {
  if (Buffer.from(key).length !== 32) invalid();
  return createHmac("sha256", Buffer.from(key)).update(heroVoiceCanaryJcsBytes(value)).digest("hex");
}

export type HeroVoiceCanaryRevealEnvelopeV1 = Readonly<{
  version: 1;
  alg: "A256GCM";
  aadSha256: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}>;

export function encryptHeroVoiceCanaryReveal(input: {
  key: Uint8Array;
  plaintext: unknown;
  aad: unknown;
  nonce?: Uint8Array;
}): { envelope: HeroVoiceCanaryRevealEnvelopeV1; envelopeBytes: Buffer; plaintextBytes: Buffer } {
  const key = Buffer.from(input.key);
  const nonce = input.nonce ? Buffer.from(input.nonce) : randomBytes(12);
  if (key.length !== 32 || nonce.length !== 12) invalid();
  const plaintextBytes = heroVoiceCanaryJcsBytes(input.plaintext);
  const aadBytes = heroVoiceCanaryJcsBytes(input.aad);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aadBytes);
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Object.freeze({
    version: 1 as const,
    alg: "A256GCM" as const,
    aadSha256: heroVoiceCanarySha256(aadBytes),
    nonce: encodeHeroVoiceCanaryBase64url(nonce),
    ciphertext: encodeHeroVoiceCanaryBase64url(ciphertext),
    tag: encodeHeroVoiceCanaryBase64url(tag),
  });
  return { envelope, envelopeBytes: heroVoiceCanaryJcsBytes(envelope), plaintextBytes };
}

export function parseHeroVoiceCanaryRevealEnvelope(bytes: Uint8Array): HeroVoiceCanaryRevealEnvelopeV1 {
  const parsed = assertHeroVoiceCanaryExactJcs(bytes);
  if (!isRecord(parsed)
    || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify([
      "aadSha256", "alg", "ciphertext", "nonce", "tag", "version",
    ])
    || parsed.version !== 1 || parsed.alg !== "A256GCM"
    || typeof parsed.aadSha256 !== "string" || !HEX_SHA256.test(parsed.aadSha256)
    || typeof parsed.nonce !== "string" || typeof parsed.ciphertext !== "string" || typeof parsed.tag !== "string") {
    invalid();
  }
  decodeHeroVoiceCanaryBase64url(parsed.nonce, 12);
  decodeHeroVoiceCanaryBase64url(parsed.ciphertext);
  decodeHeroVoiceCanaryBase64url(parsed.tag, 16);
  return parsed as HeroVoiceCanaryRevealEnvelopeV1;
}

export function decryptHeroVoiceCanaryReveal(input: {
  key: Uint8Array;
  envelopeBytes: Uint8Array;
  aad: unknown;
}): { plaintext: unknown; plaintextBytes: Buffer } {
  const key = Buffer.from(input.key);
  if (key.length !== 32) invalid();
  const envelope = parseHeroVoiceCanaryRevealEnvelope(input.envelopeBytes);
  const aadBytes = heroVoiceCanaryJcsBytes(input.aad);
  if (!heroVoiceCanaryHexMatches(envelope.aadSha256, heroVoiceCanarySha256(aadBytes))) invalid();
  const nonce = decodeHeroVoiceCanaryBase64url(envelope.nonce, 12);
  const ciphertext = decodeHeroVoiceCanaryBase64url(envelope.ciphertext);
  const tag = decodeHeroVoiceCanaryBase64url(envelope.tag, 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aadBytes);
    decipher.setAuthTag(tag);
    const plaintextBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { plaintext: assertHeroVoiceCanaryExactJcs(plaintextBytes), plaintextBytes };
  } catch {
    invalid();
  }
}
