import readline from "node:readline";
import { pathToFileURL } from "node:url";

import {
  HERO_VOICE_CANARY_ADAPTER_FORBIDDEN_ENVIRONMENT_KEYS,
} from "../src/lib/hero-voice-canary-task7-adapter-process.server";
import { heroVoiceCanaryJcsBytes, parseHeroVoiceCanaryStrictJson } from "../src/lib/hero-voice-canary-canonical";

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function main(): Promise<void> {
  for (const key of HERO_VOICE_CANARY_ADAPTER_FORBIDDEN_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) throw new Error("task7_adapter_authority_environment_present");
  }
  const modulePath = process.argv[2];
  if (!modulePath) throw new Error("task7_adapter_module_missing");
  const loaded = await import(pathToFileURL(modulePath).href) as {
    createHeroVoiceCanaryTask7Adapter?: () => Promise<Record<string, (...args: never[]) => unknown>> | Record<string, (...args: never[]) => unknown>;
  };
  if (typeof loaded.createHeroVoiceCanaryTask7Adapter !== "function") throw new Error("task7_adapter_invalid");
  const adapter = await loaded.createHeroVoiceCanaryTask7Adapter();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of lines) {
    let id = "invalid";
    try {
      const parsed = parseHeroVoiceCanaryStrictJson(Buffer.from(line, "utf8"));
      if (!heroVoiceCanaryJcsBytes(parsed).equals(Buffer.from(line, "utf8"))
        || !exactObject(parsed, ["id", "method", "value"])
        || typeof parsed.id !== "string" || typeof parsed.method !== "string"
        || !["dispatchDirect", "submitCandidate", "awaitDirectTerminal", "evaluateBatch"].includes(parsed.method)
        || !exactObject(parsed.value,
          parsed.method === "dispatchDirect" ? ["exactJcsBase64", "slot"]
            : parsed.method === "submitCandidate" ? ["signed", "slot"]
              : parsed.method === "awaitDirectTerminal" ? ["providerJobId", "slot"]
                : parsed.method === "evaluateBatch" ? ["kind", "slots"] : [])) throw new Error("invalid");
      id = parsed.id;
      const method = adapter[parsed.method];
      if (typeof method !== "function") throw new Error("invalid");
      let signed: unknown;
      if (parsed.method === "submitCandidate") {
        const wireSigned = parsed.value.signed;
        if (!exactObject(wireSigned, ["capability", "submitHmac"])
          || typeof wireSigned.submitHmac !== "string" || !/^[0-9a-f]{64}$/u.test(wireSigned.submitHmac)) {
          throw new Error("invalid");
        }
        signed = { ...wireSigned, capabilityBytes: heroVoiceCanaryJcsBytes(wireSigned.capability) };
      }
      if (parsed.method === "dispatchDirect"
        && (typeof parsed.value.exactJcsBase64 !== "string"
          || Buffer.from(parsed.value.exactJcsBase64, "base64").toString("base64") !== parsed.value.exactJcsBase64)) {
        throw new Error("invalid");
      }
      const args = parsed.method === "dispatchDirect"
        ? [parsed.value.slot, Buffer.from(String(parsed.value.exactJcsBase64), "base64")]
        : parsed.method === "submitCandidate" ? [parsed.value.slot, signed]
          : parsed.method === "awaitDirectTerminal" ? [parsed.value.slot, parsed.value.providerJobId]
            : [parsed.value.kind, parsed.value.slots];
      const value = await method.apply(adapter, args as never);
      process.stdout.write(`${heroVoiceCanaryJcsBytes({ id, ok: true, value }).toString("utf8")}\n`);
    } catch {
      process.stdout.write(`${heroVoiceCanaryJcsBytes({ id, ok: false, value: null }).toString("utf8")}\n`);
    }
  }
}

void main().catch(() => { process.exitCode = 1; });
