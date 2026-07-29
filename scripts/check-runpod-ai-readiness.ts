import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { AI_IMAGE_MODELS, type AiImageModelDefinition } from "../src/lib/ai-image-policy";
import {
  isAiImageQuoteCostSafe,
  quoteAiImageModel,
  type AiImageCostPolicy,
} from "../src/lib/ai-image-cost-policy";

type Check = { label: string; ok: boolean; detail: string };

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function estimateEnvName(model: AiImageModelDefinition): string {
  return `AI_IMAGE_${model.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ESTIMATED_COST_USD_MICROS`;
}

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

const envFile = argument("env-file") ?? ".env";
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false, quiet: true });

const checks: Check[] = [];
function check(label: string, ok: boolean, detail: string) {
  checks.push({ label, ok, detail });
}

const hasRunpodApiKey = Boolean(process.env.RUNPOD_API_KEY?.trim());
const hasKieApiKey = Boolean(process.env.KIE_API_KEY?.trim());
const managedKie = process.env.MANAGED_KIE === "1";
const creditsLive = process.env.CREDITS_LIVE === "1";
const studioEnabled = process.env.AI_STUDIO_IMAGE_ENABLED === "1";
const production = process.env.NODE_ENV === "production";
const durableStorage = Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim())
  || process.env.AI_STUDIO_ALLOW_LOCAL_OUTPUTS === "1"
  || !production;
const policy: AiImageCostPolicy = {
  usdThbRate: positiveNumber(process.env.AI_IMAGE_COST_USD_THB_RATE, 36),
  minGrossMarginBps: nonNegativeInteger(process.env.AI_IMAGE_MIN_GROSS_MARGIN_BPS, 3_000),
};

check("CREDITS_LIVE", creditsLive, creditsLive ? "1" : "must be 1");
check("AI_STUDIO_IMAGE_ENABLED", studioEnabled, studioEnabled ? "1" : "must be 1");
check(
  "output storage",
  durableStorage,
  process.env.BLOB_READ_WRITE_TOKEN?.trim()
    ? "Vercel Blob configured"
    : process.env.AI_STUDIO_ALLOW_LOCAL_OUTPUTS === "1"
      ? "local production outputs explicitly allowed"
      : production
        ? "BLOB_READ_WRITE_TOKEN or AI_STUDIO_ALLOW_LOCAL_OUTPUTS=1 required"
        : "local public/renders storage",
);
check(
  "cost policy",
  policy.minGrossMarginBps < 10_000,
  `usdThb=${policy.usdThbRate} minGrossMargin=${(policy.minGrossMarginBps / 100).toFixed(2)}%`,
);

let readyOffers = 0;
for (const model of AI_IMAGE_MODELS) {
  let estimatedCostUsdMicros = model.estimatedCostUsdMicros;
  let configured = studioEnabled && creditsLive && durableStorage;
  const details = [`engine=${model.engine}`, `provider=${model.provider}`];

  if (model.provider === "kie") {
    configured = configured && managedKie && hasKieApiKey;
    details.push("route=kie-market");
    details.push(`MANAGED_KIE=${managedKie ? "1" : "BLOCK"}`);
    details.push(`KIE_API_KEY=${hasKieApiKey ? "SET" : "MISSING"}`);
  } else {
    configured = configured && hasRunpodApiKey;
    const explicitEndpointId = model.endpointEnv ? (process.env[model.endpointEnv] ?? "").trim() : "";
    const customZImage = model.id === "z-image-turbo" && process.env.AI_STUDIO_Z_IMAGE_ROUTE === "custom";
    const endpointId = model.id === "z-image-turbo" && !customZImage
      ? (model.endpointDefault ?? "").trim()
      : explicitEndpointId || (model.endpointDefault ?? "").trim();
    const customRoute = model.runpodProtocol === "comfy-workflow" || customZImage;
    details.push(`route=${customRoute ? "runpod-custom" : "runpod-public"}`);
    details.push(`RUNPOD_API_KEY=${hasRunpodApiKey ? "SET" : "MISSING"}`);
    details.push(`endpoint=${endpointId ? "SET" : "MISSING"}`);
    configured = configured && Boolean(endpointId);

    if (customRoute) {
      if (customZImage) configured = configured && Boolean(explicitEndpointId) && explicitEndpointId !== model.endpointDefault;
      const workflowValue = model.workflowEnv ? (process.env[model.workflowEnv] ?? "").trim() : "";
      const workflowPath = workflowValue
        ? (path.isAbsolute(workflowValue) ? workflowValue : path.resolve(process.cwd(), workflowValue))
        : "";
      let workflowOk = false;
      if (workflowPath && fs.existsSync(workflowPath)) {
        try {
          const source = fs.readFileSync(workflowPath, "utf8");
          const parsed = JSON.parse(source);
          const requiredTokens = ["{{PROMPT}}", "{{NEGATIVE_PROMPT}}", "{{WIDTH}}", "{{HEIGHT}}", "{{SEED}}"];
          const hasAllTokens = requiredTokens.every((token) => source.includes(token));
          const hasImageOutput = source.includes('"class_type"')
            && (source.includes('"SaveImage"') || source.includes('"PreviewImage"'));
          workflowOk = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && hasAllTokens && hasImageOutput);
          details.push(`workflow=${workflowOk ? "VALID" : "INVALID_CONTRACT"}`);
        } catch {
          details.push("workflow=INVALID_JSON");
        }
      } else {
        details.push(`workflow=${workflowValue ? "NOT_FOUND" : "MISSING"}`);
      }
      configured = configured && workflowOk;
      estimatedCostUsdMicros = nonNegativeInteger(
        process.env[estimateEnvName(model)],
        model.id === "z-image-turbo" ? 50_000 : model.estimatedCostUsdMicros,
      );
    } else {
      if (model.id === "z-image-turbo") {
        const publicEnabled = process.env.AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED === "1";
        configured = configured && publicEnabled;
        details.push(`publicRecoveryGate=${publicEnabled ? "OPEN" : "BLOCK"}`);
      }
      details.push("workflow=NOT_REQUIRED");
    }
  }

  const quoteModel = details.includes("route=runpod-custom") && model.customCreditCostKey
    ? { ...model, creditCostKey: model.customCreditCostKey }
    : model;
  const quote = quoteAiImageModel(quoteModel, estimatedCostUsdMicros, policy);
  const costSafe = isAiImageQuoteCostSafe(quote);
  details.push(`credits=${quote.credits}`);
  details.push(`cogs=${dollars(quote.estimatedProviderCostUsdMicros)}`);
  details.push(`budget=${dollars(quote.costBudgetUsdMicros)}`);
  details.push(`costGuard=${costSafe ? "PASS" : "BLOCK"}`);
  const offerReady = configured && costSafe;
  if (offerReady) readyOffers += 1;
  check(`offer ${model.id}`, offerReady, details.join(" "));
}

async function finishReadinessCheck() {
  const prisma = new PrismaClient();
  let durableSchemaReady = false;
  try {
    const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      'SELECT name FROM sqlite_master WHERE type = "table" AND name IN ("AiGenerationJob", "AiGenerationAttempt")',
    );
    const jobColumns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      'PRAGMA table_info("AiGenerationJob")',
    );
    const tableNames = new Set(tables.map((row) => row.name));
    const columnNames = new Set(jobColumns.map((row) => row.name));
    durableSchemaReady = tableNames.has("AiGenerationJob")
      && tableNames.has("AiGenerationAttempt")
      && columnNames.has("quoteVersion")
      && columnNames.has("providerRoute")
      && columnNames.has("costBudgetUsdMicros")
      && columnNames.has("providerReportedCredits");
  } catch {
    durableSchemaReady = false;
  } finally {
    await prisma.$disconnect();
  }
  check(
    "durable image-job schema",
    durableSchemaReady,
    durableSchemaReady ? "AiGenerationJob + AiGenerationAttempt ready" : "apply the Prisma schema before image traffic",
  );

  for (const item of checks) {
    console.log(`${item.ok ? "PASS" : "BLOCK"} ${item.label}: ${item.detail}`);
  }
  const runpodOffers = checks.filter((item) => item.label.startsWith("offer ") && item.detail.includes("engine=runpod"));
  const cloudOffers = checks.filter((item) => item.label.startsWith("offer ") && item.detail.includes("engine=cloud"));
  console.log(`\nRunPod AI ready: ${runpodOffers.filter((item) => item.ok).length}/${runpodOffers.length}`);
  console.log(`Cloud API ready: ${cloudOffers.filter((item) => item.ok).length}/${cloudOffers.length}`);
  console.log(`Configuration deployment gate: ${durableSchemaReady && readyOffers > 0 ? "PASS" : "BLOCK"}`);
  console.log("Live provider gate: NOT RUN (a successful provider smoke is required before traffic is enabled)");
  if (!durableSchemaReady || readyOffers === 0) process.exitCode = 1;
}

void finishReadinessCheck().catch((error) => {
  console.error(`Readiness check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
