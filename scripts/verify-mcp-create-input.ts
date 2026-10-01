import { createVideoJobInputSchema } from "../src/lib/mcp/create-video-input";
import { mcpBrollJobFields, mcpHeroVisualRefusal } from "../src/lib/mcp/broll-source";
import { stockVideoProvidersMayBeUsed } from "../src/lib/key-preflight";

let passed = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
  passed += 1;
}

const selected = createVideoJobInputSchema.parse({
  script: "สวัสดีครับ",
  voiceProvider: "gemini",
  geminiVoiceName: "Kore",
});
check(selected.geminiVoiceName === "Kore", "create_video_job accepts a listed Gemini voice");

check(
  createVideoJobInputSchema.safeParse({
    script: "สวัสดีครับ",
    voiceProvider: "gemini",
    geminiVoiceName: "not-a-real-voice",
  }).success === false,
  "create_video_job rejects an unknown Gemini voice before queueing",
);

const avatarV = createVideoJobInputSchema.parse({
  script: "สวัสดีครับ",
  avatarMode: "full",
  avatarId: "private-look",
  avatarEngine: "avatar_v",
});
check(avatarV.avatarEngine === "avatar_v", "create_video_job preserves an explicit Avatar V selection");
check(
  createVideoJobInputSchema.safeParse({ script: "สวัสดีครับ", avatarEngine: "newest" }).success === false,
  "create_video_job rejects an unknown avatar engine before queueing",
);
check(
  createVideoJobInputSchema.parse({ script: "สวัสดีครับ", avatarMode: "none" }).avatarEngine === undefined,
  "avatar-off input keeps the legacy engine field absent",
);

const hero = createVideoJobInputSchema.parse({ script: "สวัสดีครับ", brollSource: "hero-ai-image" });
check(hero.brollSource === "hero-ai-image", "create_video_job accepts Hero AI Image");
const heroFields = mcpBrollJobFields("hero-ai-image");
check(
  heroFields.stockSource === "kie-image" && heroFields.imageEngine === "runpod" && heroFields.imageModel === "z-image-turbo",
  "Hero AI Image maps to the RunPod image job the worker already runs",
);
check(
  stockVideoProvidersMayBeUsed({ stockSource: heroFields.stockSource }) === false,
  "Hero AI Image does not require a stock video key",
);

const mix = mcpBrollJobFields("automix");
check(
  mix.stockSource === "auto-mix" && mix.autoMixWeights?.ai === 1 && mix.autoMixProviders?.includes("video") === true,
  "AutoMix uses the recommended stock-plus-AI mix",
);
check(
  stockVideoProvidersMayBeUsed({ stockSource: mix.stockSource, autoMixProviders: mix.autoMixProviders }) === true,
  "recommended AutoMix still uses free stock video",
);
check(Object.keys(mcpBrollJobFields("stock")).length === 0, "omitted and stock B-roll keep the worker default");
check(
  createVideoJobInputSchema.safeParse({ script: "สวัสดีครับ", brollSource: "kie" }).success === false,
  "create_video_job rejects an unknown B-roll source",
);

// PR-A security low S3: brandProfileId is bounded at the schema layer (a cuid is 25 chars;
// 64 leaves room for any id format while keeping a hostile multi-KB id out of the brand
// lookup and the 4000-char audit requestJson).
check(
  createVideoJobInputSchema.safeParse({ script: "สวัสดีครับ", brandProfileId: "cmuoikpho004klc1z90uccxtv" }).success === true,
  "create_video_job accepts a cuid brandProfileId",
);
check(
  createVideoJobInputSchema.safeParse({ script: "สวัสดีครับ", brandProfileId: "b".repeat(64) }).success === true,
  "create_video_job accepts a 64-char brandProfileId",
);
check(
  createVideoJobInputSchema.safeParse({ script: "สวัสดีครับ", brandProfileId: "b".repeat(65) }).success === false,
  "create_video_job rejects a brandProfileId longer than 64 chars before any lookup",
);

const previous = process.env.HERO_AI_IMAGE_PUBLIC;
process.env.HERO_AI_IMAGE_PUBLIC = "1";
check(
  mcpHeroVisualRefusal({ canUse: false, reason: "payment_required" }, "hero-ai-image")?.error === "plan_required",
  "a free account is refused Hero AI Image before a job exists",
);
check(
  mcpHeroVisualRefusal({ canUse: true, reason: "eligible" }, "automix") === null,
  "an eligible account can queue AutoMix",
);
if (previous === undefined) delete process.env.HERO_AI_IMAGE_PUBLIC;
else process.env.HERO_AI_IMAGE_PUBLIC = previous;

console.log(`\n✅ ALL ${passed} MCP CREATE INPUT CHECKS PASSED`);
