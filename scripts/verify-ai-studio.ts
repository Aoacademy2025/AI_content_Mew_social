import fs from "node:fs";
import {
  AI_IMAGE_MODELS,
  buildArtworkOnlyPrompt,
  dimensionsForAspectRatio,
  isAiImageAspectRatio,
  isAiImageEngine,
  isAiImageModelId,
  isAiImageStyle,
} from "../src/lib/ai-image-policy";
import { isAiImageQuoteCostSafe, quoteAiImageModel } from "../src/lib/ai-image-cost-policy";
import { omnivoiceScriptCharCapForPlan } from "../src/lib/omnivoice-limits";
import { isHeroAiBetaUser, isInternalAiBetaEnabledFor, isInternalAiTesterEmail } from "../src/lib/internal-ai-access";
import { resolveKieImageAccess } from "../src/lib/kie-image-guards";
import { isOmniVoiceUserAllowed } from "../src/lib/omnivoice-policy";

let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`  PASS  ${name}`);
  else { failures += 1; console.error(`  FAIL  ${name}`); }
}

const guarded = buildArtworkOnlyPrompt("เจ้าของร้านกาแฟในแสงเช้า", "editorial");
check("image prompt keeps the customer's subject", guarded.positive.includes("เจ้าของร้านกาแฟ"));
check("image prompt leads with the single-frame invariant", guarded.positive.startsWith("ONE UNIFIED EDGE-TO-EDGE FULL-CANVAS IMAGE"));
check("positive prompt avoids unwanted layout nouns", !/collage|storyboard|split screen|triptych|contact sheet/i.test(guarded.positive));

// ── ADR 0007 · generated-image text policy ─────────────────────────────────────
// The positive prompt is the only channel that reaches z-image-turbo, so every
// clause in it is something the model will try to render. It may carry the
// output-shape contract, the caller's subject and the rendering style — nothing
// else. Anti-text guardrails written as positive art direction ("blank and
// unmarked", "unlabeled controls") flatten clothes, packaging and screens; that
// is the defect ADR 0006 fixed in the Brand Visual compiler and ADR 0007 removed
// from this builder.
check(
  "ADR 0007: positive prompt carries no blanket text ban",
  !/language-free|text-free|\bno text\b|without (?:any )?text|\bunlettered\b|free of (?:text|writing|lettering)/i.test(guarded.positive),
);
check(
  "ADR 0007: positive prompt flattens no surface and blanks no object",
  !/\b(?:unmarked|unlabell?ed|undecorated|blank(?: and)?)\b|blank surfaces|plain empty/i.test(guarded.positive),
);
// Structural, so a legitimate STYLE_PROMPT tweak stays green while a fourth
// clause — the way the removed guardrails originally arrived — turns it red.
const guardedClauses = guarded.positive.replace(/\.$/, "").split(". ");
check(
  "ADR 0007: positive prompt is exactly shape guard, subject and style — nothing else",
  guardedClauses.length === 3
    && guardedClauses[0].startsWith("ONE UNIFIED EDGE-TO-EDGE FULL-CANVAS IMAGE")
    && guardedClauses[1] === "เจ้าของร้านกาแฟในแสงเช้า"
    && /editorial/i.test(guardedClauses[2]),
);
check(
  "ADR 0007: the single-frame output-shape guard survives in full",
  ["ONE UNIFIED EDGE-TO-EDGE FULL-CANVAS IMAGE",
    "depict exactly one moment from exactly one camera view",
    "use one spatially continuous scene across the entire canvas",
    "keep a consistent subject, setting, lighting and perspective throughout the canvas",
  ].every((clause) => guarded.positive.includes(clause)),
);
// `interfaceExpected` is gone rather than left accepted-and-ignored: an inert
// option reads as a guarantee. A screen is scene content (ADR 0006) and may show
// plausible English UI (ADR 0007), so this wrapper says nothing about screens.
const interfaceSubject = buildArtworkOnlyPrompt("เจ้าของร้านกำลังตรวจ dashboard ยอดขาย", "editorial");
check("ADR 0007: the interfaceExpected knob is removed, not left inert", buildArtworkOnlyPrompt.length === 2);
check(
  "ADR 0007: an interface subject receives no screen art direction from the wrapper",
  !/in-context screen or interface|abstract visual states|unlabell?ed controls/i.test(interfaceSubject.positive)
    && interfaceSubject.positive.includes("dashboard ยอดขาย"),
);
check(
  "ADR 0007: negative keeps the Thai and CJK script bans",
  ["Thai writing", "Chinese writing", "Japanese writing"].every((term) => guarded.negative.includes(term)),
);
check(
  "ADR 0007: negative no longer bans text, numbers, signage or English",
  !/\b(?:text|letters|words|typography|numbers|symbols|signage|label)\b|English writing/i.test(guarded.negative),
);
check(
  "ADR 0007: negative still protects the deterministic overlay layers",
  ["logo", "watermark", "signature", "brand name", "caption", "subtitle", "headline"]
    .every((term) => guarded.negative.includes(term)),
);
// ── end ADR 0007 ──────────────────────────────────────────────────────────────

check("negative prompt bans logos and watermarks", guarded.negative.includes("logo") && guarded.negative.includes("watermark"));
check("negative prompt bans multi-panel compositions", guarded.negative.includes("triptych") && guarded.negative.includes("panel borders"));
check("model registry exposes exactly the allowlisted models", AI_IMAGE_MODELS.length === 4 && AI_IMAGE_MODELS.every((model) => isAiImageModelId(model.id)));
check(
  "Z-Image keeps the official public contract and an explicit isolated custom route",
  AI_IMAGE_MODELS.some((model) => model.id === "z-image-turbo"
    && model.runpodProtocol === "public-z-image"
    && model.provider === "runpod"
    && model.estimatedCostUsdMicros === 5_000
    && model.customCreditCostKey === "image-open-custom-1k"
    && model.endpointDefault === "z-image-turbo"
    && model.workflowEnv === "RUNPOD_IMAGE_Z_IMAGE_WORKFLOW_PATH"),
);
const zImage = AI_IMAGE_MODELS.find((model) => model.id === "z-image-turbo")!;
const customZImage = { ...zImage, creditCostKey: zImage.customCreditCostKey! };
const gptImage = AI_IMAGE_MODELS.find((model) => model.id === "gpt-image-2")!;
check(
  "public Z-Image fits the 2-credit cost envelope",
  isAiImageQuoteCostSafe(quoteAiImageModel(zImage, 5_000)),
);
check(
  "custom Z-Image receives a 2-credit quote that covers the measured worker cost",
  quoteAiImageModel(customZImage, 10_000).credits === 2
    && isAiImageQuoteCostSafe(quoteAiImageModel(customZImage, 10_000)),
);
check(
  "GPT Image 2 has a separate 3-credit quote that fits its provider cost",
  gptImage.engine === "cloud"
    && gptImage.provider === "kie"
    && quoteAiImageModel(gptImage, 30_000).credits === 3
    && isAiImageQuoteCostSafe(quoteAiImageModel(gptImage, 30_000)),
);
check(
  "RunPod AI contains only RunPod models",
  AI_IMAGE_MODELS.filter((model) => model.engine === "runpod").every((model) => model.provider === "runpod"),
);
check("unknown AI engine is rejected", !isAiImageEngine("auto-fallback"));
check("unknown model is rejected", !isAiImageModelId("custom-user-checkpoint"));
check("unknown style is rejected", !isAiImageStyle("arbitrary-node"));
check("known aspect is accepted", isAiImageAspectRatio("9:16"));
check("portrait dimensions are actually portrait", dimensionsForAspectRatio("9:16").height > dimensionsForAspectRatio("9:16").width);
check("Free package maps to 2-minute script capacity", omnivoiceScriptCharCapForPlan("FREE") === 1_680);
check("Pro package maps to 6-minute script capacity", omnivoiceScriptCharCapForPlan("PRO") === 5_040);
check("Business package maps to 10-minute script capacity", omnivoiceScriptCharCapForPlan("BUSINESS") === 8_400);
check("AO Academy team domain is in the private beta", isInternalAiTesterEmail("tester@aoacademy.co"));
check("DuckyHero owner account is in the private beta", isInternalAiTesterEmail("duckyhero@gmail.com"));
check("lookalike domains cannot enter the private beta", !isInternalAiTesterEmail("user@evil-aoacademy.co"));
check("ordinary customer accounts stay outside the private beta", !isInternalAiTesterEmail("customer@gmail.com"));
check("allowlist matching is case-insensitive and trims whitespace", isInternalAiTesterEmail("  TESTER@AOACADEMY.CO "));
check("subdomains do not inherit private-beta access", !isInternalAiTesterEmail("tester@sub.aoacademy.co"));

const previousAdditionalEmails = process.env.INTERNAL_AI_ALLOWED_EMAILS;
const previousAdditionalDomains = process.env.INTERNAL_AI_ALLOWED_DOMAINS;
process.env.INTERNAL_AI_ALLOWED_EMAILS = "beta.user@example.com";
process.env.INTERNAL_AI_ALLOWED_DOMAINS = "example.net";
check("environment allowlist adds an exact beta account", isInternalAiTesterEmail("BETA.USER@example.com"));
check("environment allowlist does not admit neighboring accounts", !isInternalAiTesterEmail("other.user@example.com"));
check("environment domain allowlist adds internal AI testers", isInternalAiTesterEmail("tester@example.net"));
check(
  "environment allowlists cannot expand Hero editor access",
  !isHeroAiBetaUser({ email: "beta.user@example.com", role: "USER" })
    && !isHeroAiBetaUser({ email: "tester@example.net", role: "USER" }),
);
if (previousAdditionalEmails === undefined) delete process.env.INTERNAL_AI_ALLOWED_EMAILS;
else process.env.INTERNAL_AI_ALLOWED_EMAILS = previousAdditionalEmails;
if (previousAdditionalDomains === undefined) delete process.env.INTERNAL_AI_ALLOWED_DOMAINS;
else process.env.INTERNAL_AI_ALLOWED_DOMAINS = previousAdditionalDomains;
check("private feature opens for an internal tester before the public flag", isInternalAiBetaEnabledFor({ email: "tester@aoacademy.co" }, false));
check("private feature stays closed for a public admin-like account", !isInternalAiBetaEnabledFor({ email: "admin@gmail.com" }, false));
check("public rollout flag opens the coarse feature gate", isInternalAiBetaEnabledFor({ email: "customer@gmail.com" }, true));
check("Hero editor beta admits every administrator", isHeroAiBetaUser({ email: "admin@gmail.com", role: "ADMIN" }));
check("Hero editor beta admits AO Academy without an admin role", isHeroAiBetaUser({ email: "tester@aoacademy.co", role: "USER" }));
check("Hero editor beta admits DuckyHero without an admin role", isHeroAiBetaUser({ email: "duckyhero@gmail.com", role: "USER" }));
check("Hero editor beta rejects an ordinary customer", !isHeroAiBetaUser({ email: "customer@gmail.com", role: "USER" }));
check("Hero editor beta rejects AO Academy lookalike and subdomains",
  !isHeroAiBetaUser({ email: "tester@evil-aoacademy.co", role: "USER" })
  && !isHeroAiBetaUser({ email: "tester@sub.aoacademy.co", role: "USER" }));

const publicAdminImages = resolveKieImageAccess({
  managedKieOn: true,
  creditsLive: true,
  isAdmin: true,
  isPaidPlan: true,
  isInternalTester: false,
});
check("admin role alone cannot enter the image beta", !publicAdminImages.canUseKieImages);
const internalAdminImages = resolveKieImageAccess({
  managedKieOn: true,
  creditsLive: true,
  isAdmin: true,
  isPaidPlan: true,
  isInternalTester: true,
});
check("internal admin can enter the image beta", internalAdminImages.canUseKieImages);

const previousOmniEnabled = process.env.OMNIVOICE_ENABLED;
const previousOmniAllowlist = process.env.OMNIVOICE_ALLOWED_USER_IDS;
process.env.OMNIVOICE_ENABLED = "1";
process.env.OMNIVOICE_ALLOWED_USER_IDS = "*";
check("OmniVoice wildcard still rejects public users", !isOmniVoiceUserAllowed({ id: "public", email: "customer@gmail.com" }));
check("OmniVoice wildcard admits an internal tester", isOmniVoiceUserAllowed({ id: "team", email: "tester@aoacademy.co" }));
if (previousOmniEnabled === undefined) delete process.env.OMNIVOICE_ENABLED;
else process.env.OMNIVOICE_ENABLED = previousOmniEnabled;
if (previousOmniAllowlist === undefined) delete process.env.OMNIVOICE_ALLOWED_USER_IDS;
else process.env.OMNIVOICE_ALLOWED_USER_IDS = previousOmniAllowlist;

const imageRoute = fs.readFileSync("src/app/api/ai-studio/images/route.ts", "utf8");
const jobRoute = fs.readFileSync("src/app/api/ai-studio/jobs/[id]/route.ts", "utf8");
const credits = fs.readFileSync("src/lib/ai-generation-jobs.server.ts", "utf8");
const runpod = fs.readFileSync("src/lib/runpod-serverless.ts", "utf8");
const imageProvider = fs.readFileSync("src/lib/image-generation-provider.server.ts", "utf8");
const catalogRoute = fs.readFileSync("src/app/api/ai-studio/catalog/route.ts", "utf8");
const studioPage = fs.readFileSync("src/app/(dashboard)/ai-studio/page.tsx", "utf8");
const mediaStorage = fs.readFileSync("src/lib/ai-generation-media.server.ts", "utf8");
const imageDownload = fs.readFileSync("src/lib/ai-generation-image-download.ts", "utf8");
const prismaSchema = fs.readFileSync("prisma/schema.prisma", "utf8");
const mediaGraph = fs.readFileSync("src/lib/media-reference-graph.ts", "utf8");
const studioLayout = fs.readFileSync("src/app/(dashboard)/ai-studio/layout.tsx", "utf8");
const sidebar = fs.readFileSync("src/components/layout/sidebar.tsx", "utf8");
const bottomTabs = fs.readFileSync("src/components/layout/bottom-tabs.tsx", "utf8");
const dashboard = fs.readFileSync("src/app/(dashboard)/dashboard/page.tsx", "utf8");
const editorStep2 = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
const editorInspector = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx", "utf8");
const editorPostPhase = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "utf8");
const editorOrchestrator = fs.readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
const brollGenerateRoute = fs.readFileSync("src/app/api/videos/broll-window/generate/route.ts", "utf8");
const videoJobsRoute = fs.readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
const fetchStockRoute = fs.readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
const heroVideoImage = fs.readFileSync("src/lib/video-hero-image.server.ts", "utf8");
const editorJob = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Job.ts", "utf8");
check("server builds the artwork-only prompt", imageRoute.includes("buildArtworkOnlyPrompt(prompt, style)"));
check("image generation API enforces the internal beta", imageRoute.includes("isInternalAiTester(user)"));
check(
  "direct Studio access returns 404 outside the internal beta",
  studioLayout.includes("isInternalAiTester(user)") && studioLayout.includes("notFound()"),
);
check(
  "public navigation does not expose the Studio route",
  sidebar.includes('item.href !== "/ai-studio" || internalAiTester') &&
    bottomTabs.includes('tab.href !== "/ai-studio" || internalAiTester') &&
    dashboard.includes("internalAiTester &&"),
);
check(
  "public editor keeps AI Image and AutoMix visible, gated by the public-launch eligibility helper",
  editorStep2.includes('title: "Hero AI Image"') &&
    editorStep2.includes('title: "AutoMix"') &&
    editorStep2.includes("const heroImageUnlocked = p.heroAiImageEligible") &&
    editorStep2.includes("const autoMixUnlocked = p.heroAiImageEligible") &&
    editorStep2.includes("disabled={locked}"),
);
check(
  "Video Editor submits Hero AI Image as an explicit RunPod product",
  editorJob.includes('imageEngine: "runpod", imageModel: "z-image-turbo"')
    && videoJobsRoute.includes('useHeroRunpodImage ? { imageEngine: "runpod", imageModel: "z-image-turbo" }'),
);
check(
  "Hero video images are durable and idempotent per scene",
  fetchStockRoute.includes('idempotencyKey: `video:${videoJobId}:scene:${sourceIndex}`')
    && heroVideoImage.includes("createReservedImageJob")
    && heroVideoImage.includes("latestImageGenerationAttempt"),
);
check(
  "Hero video image path is pinned to the isolated RunPod custom endpoint without KIE fallback",
  heroVideoImage.includes('prepared.providerRoute !== "runpod-custom"')
    && !heroVideoImage.includes("kieCreateTask")
    && fetchStockRoute.includes("intentionally separate from KIE/AutoMix"),
);
check(
  "Hero image failures refund failed reservations and compensate settled scenes in an unusable batch",
  heroVideoImage.includes("failAndRefundAiJob")
    && heroVideoImage.includes("cancelRunpodImageJob")
    && fetchStockRoute.includes("refundSettledVideoImageBatch"),
);
check(
  "Hero image telemetry carries exact credit buckets and final balance",
  heroVideoImage.includes("creditsFromGranted: job.creditsFromGranted")
    && heroVideoImage.includes("creditsFromPurchased: job.creditsFromPurchased")
    && fetchStockRoute.includes("aiCreditsSpentGranted += generated.creditsFromGranted")
    && fetchStockRoute.includes("aiCreditsSpentPurchased += generated.creditsFromPurchased")
    && fetchStockRoute.includes("aiLastCreditBalanceAfterSpend = heroBalanceAfter.total"),
);
check(
  "per-scene AI Image stays visible but disabled outside the beta",
  editorInspector.includes('label: "AI Image"') &&
    editorInspector.includes('badge: aiImageEnabled ? undefined : "เร็ว ๆ นี้"') &&
    editorInspector.includes("disabled: !aiImageEnabled"),
);
check(
  "individual Hero scenes use the same product-owner-or-public plan gate as new-video generation",
  // Task 4 widened this route from the beta-only isHeroAiBetaUser to
  // isHeroAiImageEligible (beta cohort still admitted unconditionally; PRO/
  // BUSINESS/trial admitted once HERO_AI_IMAGE_PUBLIC=1) — see internal-ai-access.ts.
  editorPostPhase.includes("BROLL_WINDOW_EDIT || internalAiTester") &&
    brollGenerateRoute.includes("isHeroAiImageEligible(user)") &&
    brollGenerateRoute.includes("generateHeroImageForVideo") &&
    !brollGenerateRoute.includes("generateKieImageKenBurns"),
);
const ttsStepIndex = editorOrchestrator.indexOf('await step("tts", 10)');
const sceneSplitIndex = editorOrchestrator.indexOf("const brollWindows = brollWindowMode");
const visualStepIndex = editorOrchestrator.indexOf('await step("stock", 55)', sceneSplitIndex);
const renderStepIndex = editorOrchestrator.indexOf('await step("render", 75)', visualStepIndex);
check(
  "editor pipeline follows voice → audio-timed scenes → visuals → render",
  ttsStepIndex >= 0 && ttsStepIndex < sceneSplitIndex && sceneSplitIndex < visualStepIndex && visualStepIndex < renderStepIndex,
);
check(
  "individual scene changes reuse the free b-roll rerender path",
  editorInspector.includes('fetch("/api/videos/broll-window/generate"') &&
    fs.readFileSync("src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts", "utf8").includes('mode: "broll-rerender"'),
);
check(
  "provider request is prepared before credit reservation",
  imageRoute.indexOf("preparedProviderJob = prepareImageGeneration") >= 0
    && imageRoute.indexOf("preparedProviderJob = prepareImageGeneration") < imageRoute.indexOf("const reserved = await createReservedImageJob"),
);
check(
  "catalog and submission resolve the same cost-safe offer interface",
  catalogRoute.includes("describeImageOffer(model)")
    && catalogRoute.includes("engine: model.engine")
    && imageRoute.includes("prepareImageGeneration(model")
    && imageProvider.includes("const offer = describeImageOffer(model)"),
);
check(
  "a submitted job uses exactly its selected engine and quoted provider",
  imageRoute.includes("submitPreparedImageGeneration(preparedProviderJob, user.id)")
    && !imageRoute.includes('"gpt-image-2"')
    && imageRoute.includes("isAiImageEngine(engine)")
    && imageRoute.includes("model.engine !== engine")
    && imageProvider.includes("prepared.request.provider === \"runpod\"")
    && imageProvider.includes("prepared.request.value.model"),
);
check(
  "Cloud GPT is pinned to its quoted 1K tier",
  imageProvider.includes('resolution: "1K"'),
);
check("Runpod submission uses the async /run operation", runpod.includes('runpodFetch(prepared.endpointId, "run"'));
check(
  "custom Z-Image requires an explicit canary flag and allowlisted workflow",
  runpod.includes('process.env.AI_STUDIO_Z_IMAGE_ROUTE === "custom"')
    && runpod.includes("explicitEndpointId === model.endpointDefault")
    && runpod.includes('route: "runpod-custom"'),
);
const zImageWorkflow = fs.readFileSync("config/ai-workflows/z-image-turbo.json", "utf8");
check(
  "custom Z-Image never injects negative concept nouns into its positive-only conditioning",
  zImageWorkflow.includes('"text": "{{PROMPT}}"')
    && !zImageWorkflow.includes("{{NEGATIVE_PROMPT}}"),
);
const routeConfigurator = fs.readFileSync("scripts/configure-hero-image-custom-route.ts", "utf8");
check(
  "production route configuration can atomically refresh and verify PM2 environment state",
  routeConfigurator.includes("--restart-pm2")
    && routeConfigurator.includes('["restart", ...desiredProcessNames, "--update-env"]')
    && routeConfigurator.includes("did not load ${key}"),
);
check(
  "the broken public Z-Image route remains quarantined without an explicit recovery flag",
  runpod.includes("AI_STUDIO_Z_IMAGE_PUBLIC_ENABLED")
    && runpod.includes("if (!allowPublicZImage) return null"),
);
check(
  "official Z-Image requests keep the provider safety checker enabled",
  fs.readFileSync("src/lib/runpod-image-contract.ts", "utf8").includes("enable_safety_checker: true"),
);
check(
  "temporary and Cloud API outputs are downloaded into owned storage",
  fs.readFileSync("src/lib/runpod-image-contract.ts", "utf8").includes('type: "temporary_url"') &&
    mediaStorage.includes('type: "external_url"')
    && mediaStorage.includes('url.hostname !== "image.runpod.ai"')
    && mediaStorage.includes("assertSafeFetchUrl")
    && mediaStorage.includes("fetchImageResponseWithRetry")
    && imageDownload.includes('redirect: "error"'),
);
check(
  "provider attempts are durable and uniquely sequenced per job",
  prismaSchema.includes("model AiGenerationAttempt")
    && prismaSchema.includes("@@unique([jobId, sequence])")
    && prismaSchema.includes("providerReportedCredits")
    && credits.includes("attempts: {")
    && credits.includes("sequence: 1"),
);
check(
  "UI separates RunPod AI from Cloud API without a cross-engine fallback action",
  studioPage.includes('label: "RunPod AI"')
    && studioPage.includes('label: "Cloud API"')
    && studioPage.includes("item.engine === imageEngine")
    && studioPage.includes("engine: imageEngine")
    && studioPage.includes("ระบบจะไม่สลับข้ามกัน")
    && studioPage.includes("ไม่ส่งต่อไปอีก Engine")
    && !studioPage.includes("selectExplicitFallback")
    && !studioPage.includes("เลือก GPT Image 2 แทน"),
);
check("failed image jobs use the exact-bucket refund path", jobRoute.includes("failAndRefundAiJob") && credits.includes("creditsFromGranted"));
check("refund ledger is tied to the durable job id", credits.includes("ai-image-refund:${job.id}"));
check("completed images settle their reservation", credits.includes('"settled"'));
check("Studio outputs participate in media retention", mediaGraph.includes('safeQuery("ai-generation-job"'));

if (failures) {
  console.error(`\n${failures} AI Studio verification(s) failed.`);
  process.exit(1);
}
console.log("\nAI Studio contract checks passed.");
