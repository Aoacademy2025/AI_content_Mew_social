import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { heroVoiceCanaryJcsBytes, parseHeroVoiceCanaryStrictJson } from "@/lib/hero-voice-canary-canonical";
import type {
  HeroVoiceCanaryAdapterResult,
  HeroVoiceCanaryApplyAdapter,
  HeroVoiceCanaryBatch,
} from "@/lib/hero-voice-canary-runner.server";
import type { SignedHeroVoiceCanarySubmitCapability } from "@/lib/hero-voice-canary-admission.server";
import type { HeroVoiceCanarySlot } from "@/lib/hero-voice-canary-manifest";

const FIXED_TASK7_MODULE = "scripts/hero-voice-clone-canary-task7-adapter.ts";
const FIXED_CHILD = "scripts/hero-voice-clone-canary-adapter-child.ts";
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u;
const MAX_REPLY_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 16_777_216;
const RPC_TIMEOUT_MS: Readonly<Record<string, number>> = {
  dispatchDirect: 30_000,
  submitCandidate: 30_000,
  awaitDirectTerminal: 660_000,
  // CPU evaluation is not a provider slot; this only bounds a stuck child.
  evaluateBatch: 3_600_000,
};
const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "LANG", "LC_ALL", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "PATH", "SSL_CERT_FILE", "TMPDIR",
  "RUNPOD_API_KEY",
  "HERO_VOICE_CANARY_LOOPBACK_ORIGIN",
  "HERO_VOICE_CANARY_LOOPBACK_ATTESTATION",
  "HERO_VOICE_CANARY_LOOPBACK_COOKIE_FILE",
  "HERO_VOICE_CER_EVALUATOR_BINARY",
  "HERO_VOICE_CER_EVALUATOR_IMAGE_DIGEST",
  "HERO_VOICE_CER_EVALUATOR_MODEL_PATH",
  "HERO_VOICE_CER_EVALUATOR_MODEL_SHA256",
  "HERO_VOICE_CER_EVALUATOR_RUNTIME_FINGERPRINT",
]);
export const HERO_VOICE_CANARY_ADAPTER_FORBIDDEN_ENVIRONMENT_KEYS = Object.freeze([
  "DATABASE_URL",
  "HERO_VOICE_CANARY_ROOT",
  "HERO_VOICE_CANARY_REVIEW_ROOT",
  "HERO_VOICE_CANARY_REVIEW_KEY",
  "HERO_VOICE_CANARY_DELETION_HMAC_KEY",
  "HERO_VOICE_CANARY_SUBMIT_HMAC_KEY",
  "HERO_VOICE_CANARY_TASK6_EVIDENCE_KEY",
  "HERO_VOICE_CANARY_TASK6_GATE_SHA256",
  "HERO_VOICE_CANARY_OBJECTIVE_EVIDENCE_KEY",
  "HERO_VOICE_CANARY_ABLATION_EVIDENCE_SHA256",
  "HERO_VOICE_CANARY_FINAL_EVIDENCE_SHA256",
  "USER_VOICE_STORAGE_DIR",
] as const);

export function heroVoiceCanaryTask7AdapterEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  for (const key of HERO_VOICE_CANARY_ADAPTER_FORBIDDEN_ENVIRONMENT_KEYS) delete result[key];
  return result;
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Strict newline-JCS bridge. Task7 receives provider/loopback credentials and
 * request material only. The parent DB, storage roots, evidence HMAC keys and
 * authority-owned expected digests are neither inherited nor sent over IPC. */
export class HeroVoiceCanaryTask7AdapterProcess implements HeroVoiceCanaryApplyAdapter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private replyBytes: Buffer = Buffer.alloc(0);
  private readonly timeoutMsForTests?: number;

  constructor(input?: { modulePath?: string; testOnly?: boolean; timeoutMsForTests?: number }) {
    const modulePath = path.resolve(process.cwd(), input?.modulePath ?? FIXED_TASK7_MODULE);
    const fixed = path.resolve(process.cwd(), FIXED_TASK7_MODULE);
    const fixtureRoot = path.resolve(process.cwd(), "scripts/fixtures");
    if (modulePath !== fixed && !(input?.testOnly === true && process.env.NODE_ENV === "test"
      && modulePath.startsWith(`${fixtureRoot}${path.sep}`))) {
      throw new Error("task7_adapter_module_invalid");
    }
    if (input?.timeoutMsForTests !== undefined) {
      if (!input.testOnly || process.env.NODE_ENV !== "test"
        || !Number.isSafeInteger(input.timeoutMsForTests) || input.timeoutMsForTests < 1
        || input.timeoutMsForTests > 30_000) throw new Error("task7_adapter_test_timeout_invalid");
      this.timeoutMsForTests = input.timeoutMsForTests;
    }
    const childScript = path.resolve(process.cwd(), FIXED_CHILD);
    this.child = spawn(process.execPath, [
      "--conditions=react-server", "--import", "tsx", childScript, modulePath,
    ], {
      cwd: process.cwd(),
      env: heroVoiceCanaryTask7AdapterEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => { /* child diagnostics are intentionally not forwarded */ });
    this.child.stdout.on("data", (bytes: Buffer) => this.receiveBytes(bytes));
    this.child.once("error", () => this.failAll("task7_adapter_process_failed"));
    this.child.stdin.on("error", () => this.failAll("task7_adapter_process_write_failed"));
    this.child.stdout.on("error", () => this.failAll("task7_adapter_process_read_failed"));
    this.child.stderr.on("error", () => this.failAll("task7_adapter_process_read_failed"));
    this.child.once("exit", () => this.failAll("task7_adapter_process_exited"));
    this.child.stdout.once("end", () => this.failAll("task7_adapter_process_exited"));
  }

  private receiveBytes(bytes: Buffer): void {
    if (this.closed) return;
    // Bound buffering before parsing, including a peer that never emits LF.
    if (this.replyBytes.length + bytes.length > MAX_REPLY_BYTES) return this.failAll();
    this.replyBytes = Buffer.concat([this.replyBytes, bytes]);
    const newline = this.replyBytes.indexOf(10);
    if (newline < 0) return;
    // The protocol is strictly one-in-flight: trailing bytes cannot be a reply
    // to a request that the parent has not sent yet.
    if (newline !== this.replyBytes.length - 1) return this.failAll();
    const line = this.replyBytes.subarray(0, newline);
    this.replyBytes = Buffer.alloc(0);
    this.receive(line);
  }

  private receive(line: Buffer): void {
    let parsed: unknown;
    try { parsed = parseHeroVoiceCanaryStrictJson(line); } catch { return this.failAll(); }
    if (!heroVoiceCanaryJcsBytes(parsed).equals(line)
      || !exactObject(parsed, ["id", "ok", "value"])
      || typeof parsed.id !== "string" || typeof parsed.ok !== "boolean") return this.failAll();
    const pending = this.pending.get(parsed.id);
    if (!pending) return this.failAll();
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (parsed.ok) pending.resolve(parsed.value);
    else pending.reject(new Error("task7_adapter_child_rejected"));
  }

  private failAll(code = "task7_adapter_protocol_invalid"): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGKILL");
    this.replyBytes = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.pending.clear();
  }

  private call(method: string, value: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("task7_adapter_process_closed"));
    if (this.pending.size !== 0) return Promise.reject(new Error("task7_adapter_process_busy"));
    const id = randomUUID();
    const bytes = heroVoiceCanaryJcsBytes({ id, method, value });
    if (bytes.length + 1 > MAX_REQUEST_BYTES) return Promise.reject(new Error("task7_adapter_process_request_too_large"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failAll("task7_adapter_process_timed_out"),
        this.timeoutMsForTests ?? RPC_TIMEOUT_MS[method]);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(Buffer.concat([bytes, Buffer.from("\n")]), (error) => {
        if (error) {
          this.failAll("task7_adapter_process_write_failed");
        }
      });
    });
  }

  async dispatchDirect(slot: HeroVoiceCanarySlot, exactJcsBytes: Buffer): ReturnType<HeroVoiceCanaryApplyAdapter["dispatchDirect"]> {
    const value = await this.call("dispatchDirect", { slot, exactJcsBase64: exactJcsBytes.toString("base64") });
    if (exactObject(value, ["disposition"])) {
      if (value.disposition === "provider_rejected") return { disposition: "provider_rejected" };
      if (value.disposition === "transport_unknown") return { disposition: "transport_unknown" };
    }
    if (!exactObject(value, ["disposition", "providerJobId"])
      || value.disposition !== "provider_accepted" || typeof value.providerJobId !== "string"
      || !SAFE_PROVIDER_ID.test(value.providerJobId)) throw new Error("task7_adapter_result_invalid");
    return { disposition: "provider_accepted" as const, providerJobId: value.providerJobId };
  }

  async submitCandidate(slot: HeroVoiceCanarySlot, signed: SignedHeroVoiceCanarySubmitCapability): ReturnType<HeroVoiceCanaryApplyAdapter["submitCandidate"]> {
    if (!Buffer.isBuffer(signed.capabilityBytes)
      || !heroVoiceCanaryJcsBytes(signed.capability).equals(signed.capabilityBytes)) {
      throw new Error("task7_adapter_capability_invalid");
    }
    // Buffers are intentionally not part of the JCS domain. Send the canonical
    // object once and reconstruct its exact bytes inside the isolated child.
    const value = await this.call("submitCandidate", {
      slot, signed: { capability: signed.capability, submitHmac: signed.submitHmac },
    });
    if (exactObject(value, ["disposition"])) {
      if (value.disposition === "application_rejected") return { disposition: "application_rejected" };
      if (value.disposition === "transport_unknown") return { disposition: "transport_unknown" };
    }
    if (!exactObject(value, ["applicationJobId", "disposition"])
      || value.disposition !== "application_accepted" || typeof value.applicationJobId !== "string"
      || !SAFE_PROVIDER_ID.test(value.applicationJobId)) throw new Error("task7_adapter_result_invalid");
    return { disposition: "application_accepted" as const, applicationJobId: value.applicationJobId };
  }

  async awaitDirectTerminal(slot: HeroVoiceCanarySlot, providerJobId: string): Promise<HeroVoiceCanaryAdapterResult> {
    return await this.call("awaitDirectTerminal", { slot, providerJobId }) as HeroVoiceCanaryAdapterResult;
  }

  async evaluateBatch(kind: "ablation-8" | "final-36", slots: readonly HeroVoiceCanarySlot[]): Promise<HeroVoiceCanaryBatch> {
    return await this.call("evaluateBatch", { kind, slots }) as HeroVoiceCanaryBatch;
  }

  async dispose(): Promise<void> {
    this.failAll("task7_adapter_process_closed");
  }
}
