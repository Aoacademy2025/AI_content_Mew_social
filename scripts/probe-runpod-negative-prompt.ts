/**
 * RunPod Negative-Prompt Acceptance Probe (docs/plans/2026-08-10-image-text-policy.md, Task 1)
 *
 * The single question this script answers empirically: does the live RunPod
 * `z-image-turbo` PUBLIC endpoint honour a negative-prompt field at all?
 *
 * `publicZImageProviderInput()` (src/lib/runpod-image-contract.ts:42-55) — the
 * only path every production z-image-turbo call takes
 * (src/lib/runpod-serverless.ts:159-161) — builds its RunPod payload from only
 * `{ prompt, size, seed, output_format, enable_safety_checker }` and silently
 * drops `negativePrompt`. Nobody has checked whether the endpoint would have
 * honoured it under a different field name. This script does NOT modify or
 * import any production negative-prompt plumbing — it builds the same base
 * payload production sends (via `publicZImageProviderInput`) and, for the
 * "variant" cases only, adds a candidate field on top, entirely inside this
 * script.
 *
 * Method: two independent, visually unambiguous test concepts, each submitted
 * three times at ONE FIXED SEED so the field is the only variable:
 *   1. baseline       — no negative field at all (byte-identical to what
 *                        production actually sends today)
 *   2. negative_prompt — baseline + { negative_prompt: <text> }
 *   3. negativePrompt  — baseline + { negativePrompt: <text> }
 *
 * Test concepts:
 *   - "color"  — positive prompt explicitly demands vivid saturated color;
 *     negative asks to remove color. If honoured, the image should turn
 *     desaturated/monochrome despite the positive prompt fighting it — an
 *     unmissable, unambiguous visual signal.
 *   - "person" — positive prompt places a vendor and a customer in frame;
 *     negative asks to remove people. If honoured, the stall should render
 *     empty of any person.
 *
 * 2 concepts x 3 variants = 6 images (the stated budget maximum).
 *
 * Every raw HTTP response (submit + final status, i.e. the full RunPod
 * envelope including `output`) is written to disk per case, not just the
 * image. A checksum (sha256) of each downloaded image's raw bytes is recorded
 * so "pixel-identical across variants" is checkable, not eyeballed.
 *
 * DEFAULT MODE IS DRY-RUN: `--dry-run` (default, also accepted explicitly)
 * makes no network calls — it only prints/writes the six payloads that would
 * be sent. `--generate` is required to actually call RunPod, spend credits,
 * and write images/responses. Resumable: an existing image file for a case id
 * is skipped without a provider call, same as the other probe scripts.
 *
 * This task is measurement only — no production code is changed here.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { publicZImageProviderInput, type RunpodJobResponse } from "../src/lib/runpod-image-contract";

dotenv.config({ path: ".env", override: false, quiet: true });

const args = process.argv.slice(2);
const GENERATE = args.includes("--generate");

const OUTPUT_ROOT = path.resolve("artifacts/runpod-negative-prompt-probe-2026-08-10");
const IMAGE_ROOT = path.join(OUTPUT_ROOT, "images");
const RESPONSE_ROOT = path.join(OUTPUT_ROOT, "responses");
const REPORT_PATH = path.join(OUTPUT_ROOT, "report.md");

const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_IMAGE_Z_IMAGE_ENDPOINT_ID?.trim() || "z-image-turbo";

// ---------------------------------------------------------------------------
// Test concepts
// ---------------------------------------------------------------------------
type FieldVariant = "baseline" | "negative_prompt" | "negativePrompt";
const FIELD_VARIANTS: readonly FieldVariant[] = ["baseline", "negative_prompt", "negativePrompt"];

type Concept = {
  id: "color" | "person";
  labelEn: string;
  positive: string;
  negativeText: string;
  seed: number;
  expectationIfHonoured: string;
};

const CONCEPTS: readonly Concept[] = [
  {
    id: "color",
    labelEn: "Color suppression — positive demands vivid color, negative asks to remove it",
    positive: [
      "ONE UNIFIED EDGE-TO-EDGE FULL-CANVAS IMAGE, one continuous scene, one camera view",
      "a vibrant tropical fruit stand piled high with mangoes, papayas, dragon fruit and bananas",
      "extremely vivid, highly saturated red, orange, yellow and green colors throughout the entire frame",
      "bright tropical midday sunlight, punchy saturated color grading",
      "photorealistic commercial photography",
    ].join(". ") + ".",
    negativeText: "color, colour, saturated, saturated colors, vivid colors, vibrant colors",
    seed: 2026081001,
    expectationIfHonoured: "the fruit stand should render visibly desaturated / near-monochrome despite the positive prompt explicitly fighting for saturated color",
  },
  {
    id: "person",
    labelEn: "Person suppression — positive places a vendor and a customer, negative asks to remove people",
    positive: [
      "ONE UNIFIED EDGE-TO-EDGE FULL-CANVAS IMAGE, one continuous scene, one camera view",
      "a small morning market vegetable stall with a vendor arranging fresh produce",
      "a customer standing at the counter paying the vendor for a bag of vegetables",
      "both the vendor and the customer clearly visible in frame, natural morning light",
      "photorealistic commercial photography",
    ].join(". ") + ".",
    negativeText: "person, people, human, man, woman, face, figure, human being",
    seed: 2026081002,
    expectationIfHonoured: "the stall should render with no vendor and no customer present, despite the positive prompt explicitly placing both in frame",
  },
] as const;

type ProbeCase = {
  caseId: string;
  concept: Concept;
  variant: FieldVariant;
};

function buildCases(): ProbeCase[] {
  const cases: ProbeCase[] = [];
  for (const concept of CONCEPTS) {
    for (const variant of FIELD_VARIANTS) {
      cases.push({ caseId: `${concept.id}-${variant}`, concept, variant });
    }
  }
  return cases;
}

/** Build the exact payload this case will submit. `baseline` is byte-identical
 * to what `publicZImageProviderInput` sends in production today — no field is
 * added. The two variant cases start from that same base and add ONE
 * candidate negative field on top, entirely in this script (never in
 * production code). */
function buildProviderInput(item: ProbeCase): Record<string, unknown> {
  const base = publicZImageProviderInput({
    prompt: item.concept.positive,
    width: 1024,
    height: 1024,
    seed: item.concept.seed,
  });
  if (item.variant === "baseline") return base;
  return { ...base, [item.variant]: item.concept.negativeText };
}

// ---------------------------------------------------------------------------
// Dry-run: print + write the six payloads, no network calls
// ---------------------------------------------------------------------------
function writeDryRunReport(cases: ProbeCase[]): void {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const lines: string[] = [
    "# RunPod Negative-Prompt Acceptance Probe — dry run",
    "",
    `Generated ${new Date().toISOString()} by scripts/probe-runpod-negative-prompt.ts --dry-run.`,
    "No network calls were made to produce this file.",
    "",
    "Re-run with --generate to submit the 6 jobs to RunPod (budget: 6 images maximum).",
    "",
  ];
  for (const concept of CONCEPTS) {
    lines.push(
      `## ${concept.labelEn} (\`${concept.id}\`)`,
      "",
      `**seed (fixed across all 3 variants):** ${concept.seed}`,
      `**Expectation if the field is honoured:** ${concept.expectationIfHonoured}`,
      "",
      "**Positive prompt:**",
      "```",
      concept.positive,
      "```",
      "",
      "**Negative text (candidate field value):**",
      "```",
      concept.negativeText,
      "```",
      "",
    );
    for (const variant of FIELD_VARIANTS) {
      const item = cases.find((c) => c.concept.id === concept.id && c.variant === variant)!;
      lines.push(
        `### variant \`${variant}\` (case \`${item.caseId}\`)`,
        "```json",
        JSON.stringify(buildProviderInput(item), null, 2),
        "```",
        "",
      );
    }
  }
  fs.writeFileSync(REPORT_PATH, lines.join("\n"));
  console.log(`wrote ${REPORT_PATH}`);
}

// ---------------------------------------------------------------------------
// --generate: real RunPod Z-Image path
// ---------------------------------------------------------------------------
const IMAGE_EXTENSIONS = [".png", ".jpg", ".webp"] as const;

function existingImagePath(caseId: string): string | null {
  for (const extension of IMAGE_EXTENSIONS) {
    const candidate = path.join(IMAGE_ROOT, `${caseId}${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function existingResponsePath(caseId: string): string | null {
  const candidate = path.join(RESPONSE_ROOT, `${caseId}.json`);
  return fs.existsSync(candidate) ? candidate : null;
}

async function runpod(apiKey: string, operation: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: string; parsed: RunpodJobResponse | null }> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(RUNPOD_ENDPOINT_ID)}/${operation}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let parsed: RunpodJobResponse | null = null;
      try { parsed = JSON.parse(text) as RunpodJobResponse; } catch { parsed = null; }
      if (response.ok || (response.status < 500 && response.status !== 429)) {
        return { status: response.status, ok: response.ok, body: text, parsed };
      }
      lastError = new Error(parsed?.error || `Runpod request failed (${response.status})`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Runpod request failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
  }
  throw lastError ?? new Error("Runpod request failed");
}

async function downloadImage(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "image.runpod.ai") {
    throw new Error(`Unexpected RunPod output host: ${parsed.hostname}`);
  }
  const response = await fetch(parsed, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`RunPod image redirected (${response.status})`);
  }
  if (!response.ok) throw new Error(`RunPod image download failed (${response.status})`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim() || "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    throw new Error(`Unexpected RunPod image type: ${contentType || "missing"}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("RunPod image size is invalid");
  return { bytes, contentType };
}

type CaseResult = {
  caseId: string;
  conceptId: string;
  variant: FieldVariant;
  requestPayload: Record<string, unknown>;
  submitResponse: unknown;
  finalStatusResponse: unknown;
  submitHttpStatus: number;
  finalHttpStatus: number;
  imagePath: string | null;
  imageSha256: string | null;
  error: string | null;
};

function writeResponseRecord(caseId: string, record: Omit<CaseResult, "caseId">): void {
  fs.mkdirSync(RESPONSE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(RESPONSE_ROOT, `${caseId}.json`), JSON.stringify({ caseId, ...record }, null, 2));
}

async function generateOne(apiKey: string, item: ProbeCase): Promise<CaseResult> {
  const existingImage = existingImagePath(item.caseId);
  const existingResponse = existingResponsePath(item.caseId);
  if (existingImage && existingResponse) {
    console.log(`SKIP ${item.caseId} (already on disk: ${path.relative(OUTPUT_ROOT, existingImage)})`);
    const record = JSON.parse(fs.readFileSync(existingResponse, "utf8")) as CaseResult;
    return record;
  }

  const requestPayload = buildProviderInput(item);
  let submit: Awaited<ReturnType<typeof runpod>>;
  try {
    submit = await runpod(apiKey, "run", { method: "POST", body: JSON.stringify({ input: requestPayload }) });
  } catch (error) {
    const result: CaseResult = {
      caseId: item.caseId,
      conceptId: item.concept.id,
      variant: item.variant,
      requestPayload,
      submitResponse: null,
      finalStatusResponse: null,
      submitHttpStatus: 0,
      finalHttpStatus: 0,
      imagePath: null,
      imageSha256: null,
      error: error instanceof Error ? error.message : "submit failed",
    };
    writeResponseRecord(item.caseId, result);
    throw new Error(`${item.caseId}: submit failed — ${result.error}`);
  }

  const jobId = submit.parsed?.id;
  console.log(`SUBMIT ${item.caseId} http=${submit.status} job=${jobId ?? "NONE"} status=${submit.parsed?.status ?? "UNKNOWN"}`);

  if (!jobId) {
    // The endpoint rejected the request outright (e.g. unknown-field schema
    // validation) — this IS evidence, not a script bug. Record it and move on.
    const result: CaseResult = {
      caseId: item.caseId,
      conceptId: item.concept.id,
      variant: item.variant,
      requestPayload,
      submitResponse: submit.parsed ?? submit.body,
      finalStatusResponse: null,
      submitHttpStatus: submit.status,
      finalHttpStatus: 0,
      imagePath: null,
      imageSha256: null,
      error: "RunPod accepted the HTTP request without a job id (no id in submit response)",
    };
    writeResponseRecord(item.caseId, result);
    return result;
  }

  const deadline = Date.now() + 8 * 60_000;
  let snapshot = submit;
  while (snapshot.parsed?.status !== "COMPLETED") {
    if (["FAILED", "TIMED_OUT", "CANCELLED"].includes(snapshot.parsed?.status ?? "")) {
      const result: CaseResult = {
        caseId: item.caseId,
        conceptId: item.concept.id,
        variant: item.variant,
        requestPayload,
        submitResponse: submit.parsed ?? submit.body,
        finalStatusResponse: snapshot.parsed ?? snapshot.body,
        submitHttpStatus: submit.status,
        finalHttpStatus: snapshot.status,
        imagePath: null,
        imageSha256: null,
        error: `RunPod job ${snapshot.parsed?.status} — ${snapshot.parsed?.error ?? "no error detail"}`,
      };
      writeResponseRecord(item.caseId, result);
      throw new Error(`${item.caseId}: ${result.error}`);
    }
    if (Date.now() >= deadline) throw new Error(`${item.caseId}: RunPod job exceeded 8 minutes`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    snapshot = await runpod(apiKey, `status/${encodeURIComponent(jobId)}`);
  }

  const outputUrl = snapshot.parsed?.output?.image_url ?? snapshot.parsed?.output?.result;
  let imagePath: string | null = null;
  let imageSha256: string | null = null;
  let error: string | null = null;
  if (typeof outputUrl === "string" && outputUrl.trim()) {
    try {
      const downloaded = await downloadImage(outputUrl);
      const extension = downloaded.contentType === "image/jpeg" ? ".jpg" : downloaded.contentType === "image/webp" ? ".webp" : ".png";
      const outPath = path.join(IMAGE_ROOT, `${item.caseId}${extension}`);
      fs.mkdirSync(IMAGE_ROOT, { recursive: true });
      fs.writeFileSync(outPath, downloaded.bytes);
      imagePath = outPath;
      imageSha256 = crypto.createHash("sha256").update(downloaded.bytes).digest("hex");
      console.log(`DONE ${item.caseId} -> ${path.relative(OUTPUT_ROOT, outPath)} sha256=${imageSha256.slice(0, 12)} ($${typeof snapshot.parsed?.output?.cost === "number" ? snapshot.parsed.output.cost.toFixed(6) : "?"})`);
    } catch (downloadError) {
      error = downloadError instanceof Error ? downloadError.message : "image download failed";
    }
  } else {
    error = "RunPod job COMPLETED without an image_url/result in output";
  }

  const result: CaseResult = {
    caseId: item.caseId,
    conceptId: item.concept.id,
    variant: item.variant,
    requestPayload,
    submitResponse: submit.parsed ?? submit.body,
    finalStatusResponse: snapshot.parsed ?? snapshot.body,
    submitHttpStatus: submit.status,
    finalHttpStatus: snapshot.status,
    imagePath,
    imageSha256,
    error,
  };
  writeResponseRecord(item.caseId, result);
  if (error) throw new Error(`${item.caseId}: ${error}`);
  return result;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
function writeVerdict(results: CaseResult[]): void {
  const lines: string[] = [
    "",
    "# Verdict",
    "",
  ];
  for (const concept of CONCEPTS) {
    const baseline = results.find((r) => r.conceptId === concept.id && r.variant === "baseline");
    const npUnderscore = results.find((r) => r.conceptId === concept.id && r.variant === "negative_prompt");
    const npCamel = results.find((r) => r.conceptId === concept.id && r.variant === "negativePrompt");
    lines.push(`## ${concept.labelEn} (\`${concept.id}\`)`, "");
    for (const [label, result] of [["baseline", baseline], ["negative_prompt", npUnderscore], ["negativePrompt", npCamel]] as const) {
      if (!result) { lines.push(`- ${label}: NOT RUN`); continue; }
      lines.push(`- ${label}: sha256=${result.imageSha256 ?? "N/A"} submitHttp=${result.submitHttpStatus} finalHttp=${result.finalHttpStatus} error=${result.error ?? "none"}`);
    }
    if (baseline?.imageSha256 && npUnderscore?.imageSha256) {
      lines.push(`- baseline vs negative_prompt: ${baseline.imageSha256 === npUnderscore.imageSha256 ? "BYTE-IDENTICAL (field had zero effect on output bytes)" : "DIFFERENT BYTES (field changed the output — inspect images to confirm it's the requested change, not just seed noise)"}`);
    }
    if (baseline?.imageSha256 && npCamel?.imageSha256) {
      lines.push(`- baseline vs negativePrompt: ${baseline.imageSha256 === npCamel.imageSha256 ? "BYTE-IDENTICAL (field had zero effect on output bytes)" : "DIFFERENT BYTES (field changed the output — inspect images to confirm it's the requested change, not just seed noise)"}`);
    }
    lines.push("");
  }
  fs.appendFileSync(REPORT_PATH, lines.join("\n"));
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const cases = buildCases();

  console.log("");
  console.log("=== Payloads (6 cases: 2 concepts x 3 field variants) ===");
  for (const item of cases) {
    console.log(`\n--- ${item.caseId} ---`);
    console.log(JSON.stringify(buildProviderInput(item)));
  }

  writeDryRunReport(cases);

  if (!GENERATE) {
    console.log("");
    console.log("Dry-run complete. No network calls were made. Re-run with --generate to submit the 6 jobs to RunPod.");
    return;
  }

  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("RUNPOD_API_KEY is missing from .env — refusing to start --generate.");
  }
  fs.mkdirSync(IMAGE_ROOT, { recursive: true });
  fs.mkdirSync(RESPONSE_ROOT, { recursive: true });

  const results: CaseResult[] = [];
  let failures = 0;
  for (const item of cases) {
    try {
      const result = await generateOne(apiKey, item);
      results.push(result);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${item.caseId}: ${error instanceof Error ? error.message : "unknown error"}`);
      const existing = existingResponsePath(item.caseId);
      if (existing) results.push(JSON.parse(fs.readFileSync(existing, "utf8")) as CaseResult);
    }
  }

  writeVerdict(results);

  const completed = results.filter((r) => r.imageSha256).length;
  console.log(`runpod_negative_prompt_probe completed=${completed}/${cases.length} failed=${failures}`);
  if (completed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "probe-runpod-negative-prompt failed");
  process.exit(1);
});
