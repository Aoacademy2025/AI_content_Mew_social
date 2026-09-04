import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";

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

  constructor(input?: { modulePath?: string; testOnly?: boolean }) {
    const modulePath = path.resolve(process.cwd(), input?.modulePath ?? FIXED_TASK7_MODULE);
    const fixed = path.resolve(process.cwd(), FIXED_TASK7_MODULE);
    const fixtureRoot = path.resolve(process.cwd(), "scripts/fixtures");
    if (modulePath !== fixed && !(input?.testOnly === true && process.env.NODE_ENV === "test"
      && modulePath.startsWith(`${fixtureRoot}${path.sep}`))) {
      throw new Error("task7_adapter_module_invalid");
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
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
    this.child.once("exit", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("task7_adapter_process_exited"));
      this.pending.clear();
    });
  }

  private receive(line: string): void {
    let parsed: unknown;
    try { parsed = parseHeroVoiceCanaryStrictJson(Buffer.from(line, "utf8")); } catch { return this.failAll(); }
    if (!heroVoiceCanaryJcsBytes(parsed).equals(Buffer.from(line, "utf8"))
      || !exactObject(parsed, ["id", "ok", "value"])
      || typeof parsed.id !== "string" || typeof parsed.ok !== "boolean") return this.failAll();
    const pending = this.pending.get(parsed.id);
    if (!pending) return this.failAll();
    this.pending.delete(parsed.id);
    if (parsed.ok) pending.resolve(parsed.value);
    else pending.reject(new Error("task7_adapter_child_rejected"));
  }

  private failAll(): void {
    this.closed = true;
    this.child.kill("SIGKILL");
    for (const pending of this.pending.values()) pending.reject(new Error("task7_adapter_protocol_invalid"));
    this.pending.clear();
  }

  private call(method: string, value: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("task7_adapter_process_closed"));
    const id = randomUUID();
    const bytes = heroVoiceCanaryJcsBytes({ id, method, value });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(Buffer.concat([bytes, Buffer.from("\n")]), (error) => {
        if (error) {
          this.pending.delete(id);
          reject(new Error("task7_adapter_process_write_failed"));
        }
      });
    });
  }

  async dispatchDirect(slot: HeroVoiceCanarySlot, exactJcsBytes: Buffer) {
    const value = await this.call("dispatchDirect", { slot, exactJcsBase64: exactJcsBytes.toString("base64") });
    if (!exactObject(value, ["disposition", "providerJobId"])
      || value.disposition !== "provider_accepted" || typeof value.providerJobId !== "string"
      || !SAFE_PROVIDER_ID.test(value.providerJobId)) throw new Error("task7_adapter_result_invalid");
    return { disposition: "provider_accepted" as const, providerJobId: value.providerJobId };
  }

  async submitCandidate(slot: HeroVoiceCanarySlot, signed: SignedHeroVoiceCanarySubmitCapability) {
    const value = await this.call("submitCandidate", { slot, signed });
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
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}
