import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "content-preflight-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { buildNarrativeAlignedBrollWindows } = await import("../src/lib/broll-windows");
  const { tokenizeWords } = await import("../src/lib/tts-timing");
  const {
    CONTENT_PREFLIGHT_ANALYZER_VERSION,
    ContentPreflightError,
    createGeminiContentPreflightAnalyzer,
    planNarrativeVisualWindows,
    recordVisualBeatAsset,
    resolveContentPreflight,
    reusableVisualBeatAssetsForVideoJob,
  } = await import("../src/lib/content-preflight.server");

  function completeAnalysis<T extends {
    contentDomain: string;
    suggestedVisualFormatId: string;
    beats: Array<{
      subject: string; action: string; setting: string; emotion: string; emphasis: string;
    }>;
  }>(analysis: T) {
    return {
      ...analysis,
      dominantNarrativeMode: "continuous practical explanation",
      rankedTreatmentPresetIds: [
        "expert-clarity",
        "practical-documentary",
        "modern-business-technology",
      ],
      treatmentRecommendationRationale: "The whole source is a practical explanation.",
      formatRecommendation: null,
      storyEntities: [],
      beats: analysis.beats.map((beat) => ({
        ...beat,
        hardSceneFacts: {
          entityTypes: [beat.subject], ages: [], genders: [], actions: [beat.action],
          locationTypes: [beat.setting], timeOfDay: null, historicalPeriod: null,
          count: null, essentialObjects: [],
        },
        entityRefs: [],
        sceneIntensity: "clear",
        safetyBoundary: "none",
      })),
    };
  }

  const spokenText = "Hook short. Explanation sentence one. Explanation sentence two. Close.";
  const spokenDurationMs = 9_000;
  const timedWords = tokenizeWords(spokenText).map((word) => ({
    ...word,
    startMs: Math.round((word.startChar / spokenText.length) * spokenDurationMs),
    endMs: Math.max(
      Math.round((word.startChar / spokenText.length) * spokenDurationMs) + 1,
      Math.round((word.endChar / spokenText.length) * spokenDurationMs),
    ),
  }));
  const narrativeWindows = [
    "Hook short.",
    "Explanation sentence one.\nExplanation sentence two.",
    "Close.",
  ];
  const narrativeAligned = buildNarrativeAlignedBrollWindows({
    captions: [
      { text: "Hook short.", startMs: 0, endMs: 1_000 },
      { text: "Explanation sentence one.", startMs: 1_000, endMs: 3_000 },
      { text: "Explanation sentence two.", startMs: 3_000, endMs: 8_000 },
      { text: "Close.", startMs: 8_000, endMs: 9_000 },
    ],
    words: timedWords,
    spokenText,
    narrativeWindows,
    audioEndMs: spokenDurationMs,
  });
  assert.ok(narrativeAligned, "the exact accepted Narrative windows align onto the TTS timeline");
  assert.deepEqual(
    narrativeAligned.map((window) => window.text),
    narrativeWindows,
    "render windows use the same story intent boundaries the Content Preflight analyzed",
  );
  assert.equal(narrativeAligned[0].startMs, 0);
  assert.equal(narrativeAligned.at(-1)?.endMs, spokenDurationMs);
  assert.ok(
    narrativeAligned[0].endMs < 3_000 && narrativeAligned[1].endMs > 6_000,
    "timing follows Narrative boundaries rather than unrelated equal-time fixed-count groups",
  );
  assert.equal(buildNarrativeAlignedBrollWindows({
    captions: [{ text: "different", startMs: 0, endMs: 1_000 }],
    words: timedWords,
    spokenText,
    narrativeWindows: ["a different narrative"],
    audioEndMs: spokenDurationMs,
  }), null, "a mismatched accepted Narrative fails closed instead of pairing the wrong Beat by index");

  const stableWindowSource = [
    "ปัญหาแรกเกิดขึ้นในวันนี้",
    "วิธีแก้ที่สองทำได้ทุกเดือน",
    "ผลลัพธ์สุดท้ายชัดเจนและวัดได้",
  ].join("\n");
  const stableWindows = planNarrativeVisualWindows(stableWindowSource, 3);
  const prefixedStableWindows = planNarrativeVisualWindows(`เกริ่นสั้นๆ ${stableWindowSource}`, 3);
  assert.deepEqual(
    prefixedStableWindows.slice(1),
    stableWindows.slice(1),
    "a local prefix edit must not shift the unchanged downstream Narrative windows",
  );

  const user = await prisma.user.create({
    data: {
      name: "Preflight owner", email: "preflight@example.test", geminiKey: "test-gemini-key",
      plan: "PRO", subStatus: "active", stripeSubscriptionId: "sub_preflight",
      planExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.payment.create({ data: {
    userId: user.id, stripeSessionId: "cs_preflight", plan: "PRO", amount: 9900,
    status: "PAID", periodDays: 30, paidAt: new Date(),
  } });

  const eightWindows = Array.from({ length: 8 }, (_, index) => ({
    text: `ฉากทดสอบ ${index + 1}`,
    startMs: index * 4_000,
    endMs: (index + 1) * 4_000,
  }));
  const validEightBeatAnalysis = completeAnalysis({
    contentDomain: "education",
    suggestedVisualFormatId: "clear-infographic",
    suggestedTreatment: { label: "ชัดเจน", mood: "focused" },
    beats: eightWindows.map((window, index) => ({
      beatKey: `window-${index}`,
      sourceExcerpt: window.text,
      startMs: window.startMs,
      endMs: window.endMs,
      subject: `subject ${index}`,
      action: `action ${index}`,
      setting: `setting ${index}`,
      emotion: "focused",
      emphasis: `point ${index}`,
    })),
  });
  let providerSafeStructuredOutputRequested = false;
  let capturedPreflightPrompt = "";
  const structuredAnalyzer = createGeminiContentPreflightAnalyzer(
    user.id,
    async (_key, promptText, _maxTokens, _temperature, rawOptions) => {
      capturedPreflightPrompt = promptText;
      const options = (rawOptions ?? {}) as typeof rawOptions & {
        responseMimeType?: string;
        responseJsonSchema?: {
          properties?: {
            beats?: { type?: string; items?: unknown; minItems?: number; maxItems?: number };
          };
        };
      };
      const providerBeatsSchema = options.responseJsonSchema?.properties?.beats;
      providerSafeStructuredOutputRequested = options.responseMimeType === "application/json"
        && providerBeatsSchema?.type === "array"
        && Boolean(providerBeatsSchema.items)
        && providerBeatsSchema.minItems === undefined
        && providerBeatsSchema.maxItems === undefined;
      return providerSafeStructuredOutputRequested
        ? JSON.stringify(validEightBeatAnalysis)
        : `ผลวิเคราะห์:\n${JSON.stringify(validEightBeatAnalysis)}`;
    },
  );
  try {
    const structured = await structuredAnalyzer.analyze({
      kind: "upload-transcript",
      text: eightWindows.map((window) => window.text).join("\n"),
      windows: eightWindows,
    });
    assert.equal(structured.beats.length, eightWindows.length);
  } catch (error) {
    assert.ok(
      error instanceof ContentPreflightError
        && error.code === "INVALID_ANALYSIS"
        && error.message === "AI ส่งผลวิเคราะห์ที่อ่านไม่ได้ กรุณาลองใหม่",
      "the upload Brand Visual replay must reproduce the production failure before structured output is enabled",
    );
    throw error;
  }
  assert.equal(
    providerSafeStructuredOutputRequested,
    true,
    "upload Brand Visual must request structured JSON without a nested array-length constraint that Gemini rejects at 5+ beats",
  );

  const aiAgentWindows = [{ text: "AI Agent ตัดสินใจเรื่องราคาแทนพนักงาน" }];
  const validAiAgentAnalysis = completeAnalysis({
    contentDomain: "business automation governance",
    suggestedVisualFormatId: "clear-infographic",
    beats: [{
      beatKey: "window-0",
      sourceExcerpt: aiAgentWindows[0].text,
      subject: "an automated decision system and a human approval checkpoint",
      action: "routes a price change to a human reviewer",
      setting: "a business operations room",
      emotion: "careful oversight",
      emphasis: "human approval before an automated pricing decision",
    }],
  });
  const invalidAiAgentAnalysis = {
    ...validAiAgentAnalysis,
    storyEntities: [{
      entityId: "entity-ai-agent",
      properName: "AI Agent",
      entityType: "object",
      durableAttributes: ["autonomous business software"],
      renderingDescription: "an AI Agent that changes product prices",
      recurringCharacterDescription: null,
      isRealPerson: false,
    }],
    beats: validAiAgentAnalysis.beats.map((beat) => ({
      ...beat,
      entityRefs: ["entity-ai-agent"],
    })),
  };
  let semanticCorrectionCalls = 0;
  const semanticCorrectionPrompts: string[] = [];
  const semanticCorrectionAnalyzer = createGeminiContentPreflightAnalyzer(
    user.id,
    async (_key, prompt) => {
      semanticCorrectionCalls += 1;
      semanticCorrectionPrompts.push(prompt);
      return JSON.stringify(
        semanticCorrectionCalls === 1 ? invalidAiAgentAnalysis : validAiAgentAnalysis,
      );
    },
  );
  const correctedAiAgent = await semanticCorrectionAnalyzer.analyze({
    kind: "upload-transcript",
    text: aiAgentWindows[0].text,
    windows: aiAgentWindows,
  });
  assert.equal(
    semanticCorrectionCalls,
    1,
    "a generic AI role is repaired deterministically without paying for another provider attempt",
  );
  assert.deepEqual(correctedAiAgent.storyEntities, []);
  assert.match(
    semanticCorrectionPrompts[0] ?? "",
    /generic (?:roles|types)[\s\S]*AI Agent/i,
    "the first attempt tells the model not to misclassify a generic AI Agent role as a proper name",
  );

  let exhaustedSemanticCalls = 0;
  const exhaustedSemanticAnalyzer = createGeminiContentPreflightAnalyzer(
    user.id,
    async () => {
      exhaustedSemanticCalls += 1;
      return JSON.stringify(invalidAiAgentAnalysis);
    },
  );
  const deterministicAiAgent = await exhaustedSemanticAnalyzer.analyze({
    kind: "upload-transcript",
    text: aiAgentWindows[0].text,
    windows: aiAgentWindows,
  });
  assert.deepEqual(deterministicAiAgent.storyEntities, []);
  assert.equal(
    exhaustedSemanticCalls,
    1,
    "the same unsafe response cannot exhaust all semantic attempts after deterministic repair",
  );

  /** ── Image text policy lives here, not in the prompt compiler ─────────────
   * The image model has no negative-prompt channel (`z-image-turbo` is
   * `negativePromptDelivery: "ignored"`), so the positive prompt is the only
   * thing that reaches it — and the positive prompt is built from these beats.
   * Shaping WHAT is requested is safe; a compiler clause shaping HOW every frame
   * renders is the exact change that produced the storytelling bug ADR 0006
   * fixed. So the whole intervention is a writing-system rule at this layer. */
  assert.match(
    capturedPreflightPrompt,
    /may be what a beat is about when the source is genuinely about what it displays/,
    "ADR 0007: a surface that has to be read may be a beat's focal subject when the story is about it",
  );
  assert.match(
    capturedPreflightPrompt,
    /give its wording in English using the Latin alphabet/,
    "the rule names the writing system to use rather than a vague 'text-free' instruction",
  );
  assert.match(
    capturedPreflightPrompt,
    /Describe lettering in no other writing system/,
    "everything outside the Latin alphabet is excluded by naming what to write, not by listing scripts",
  );
  assert.match(
    capturedPreflightPrompt,
    /Write every field in English, whatever language the Narrative Source is written in/,
    "beat fields are contracted to English, which is what makes the compiler-side strip a backstop and not a scalpel",
  );
  /** Without this, "avoid signage" comes back as `setting: "a street with no
   * signs"`, and a diffusion text encoder reads a negated concept as a positive
   * cue — the beat would then draw the very thing it excluded. */
  assert.match(
    capturedPreflightPrompt,
    /Never phrase a field as an absence, and never name something in order to exclude it/,
    "beats must describe presence only, because every field is concatenated into a positive prompt",
  );
  /** Generated images follow the story's own context, so the instruction may
   * name a writing system but never a place or a nationality: `-v2`'s
   * "believable Thai environments" is exactly the lock Mew rejected on
   * 2026-08-10. "English" and "Latin" are permitted here and only here, as the
   * alphabet lettering is written in — not as a country. */
  const beatInstruction = capturedPreflightPrompt.slice(
    capturedPreflightPrompt.indexOf("Each beat must describe"),
    capturedPreflightPrompt.indexOf("Schema:"),
  );
  assert.doesNotMatch(
    beatInstruction,
    /\b(?:thai|thailand|bangkok|asian|southeast|chinese|japanese|korean|arabic|cyrillic)\b|ไทย/i,
    "the beat instruction must name no locale and no other writing system",
  );
  assert.match(capturedPreflightPrompt, /not a montage and not typography/,
    "the single-frozen-moment requirement survives the rewrite");
  /** The preflight cache is keyed on the analyzer version, so an instruction
   * change that is not accompanied by a bump would keep serving pre-policy beats
   * from cache — the policy would silently apply to new sources only. */
  assert.equal(
    CONTENT_PREFLIGHT_ANALYZER_VERSION,
    "brand-content-preflight-v12-semantic-self-correction",
    "changing what a beat contains must publish a new analyzer version",
  );
  const preflightSource = readFileSync("src/lib/content-preflight.server.ts", "utf8");
  assert.match(
    preflightSource,
    /COMPATIBLE_CONTENT_PREFLIGHT_ANALYZER_VERSIONS = \[[\s\S]*?"brand-content-preflight-v6-treatment-plan"[\s\S]*?"brand-content-preflight-v5-latin-lettering"[\s\S]*?"brand-content-preflight-v4-focal-subject"/,
    "the superseded version stays readable as lineage, so a bump costs a re-analysis and never a generated image",
  );
  const project = await prisma.editorProject.create({
    data: { userId: user.id, title: "Creator script" },
  });
  const countGuardProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Exact beat count guard" },
  });
  await assert.rejects(
    () => resolveContentPreflight({
      userId: user.id,
      projectId: countGuardProject.id,
      narrativeSource: {
        kind: "creator-script",
        text: "ฉากแรก\nฉากที่สอง",
        windows: [{ text: "ฉากแรก" }, { text: "ฉากที่สอง" }],
      },
      analyzer: {
        analyze: async () => completeAnalysis({
          contentDomain: "education",
          suggestedVisualFormatId: "clear-infographic",
          beats: [{
            beatKey: "window-0",
            sourceExcerpt: "ฉากแรก",
            subject: "one learner",
            action: "reviews the first lesson",
            setting: "a study desk",
            emotion: "focused",
            emphasis: "the first lesson",
          }],
        }) as never,
      },
    }),
    (error: unknown) => error instanceof ContentPreflightError
      && error.code === "INVALID_ANALYSIS"
      && error.message === "ผลวิเคราะห์ต้องมีข้อมูลครบทั้ง 2 ฉาก",
    "the server must keep exact beat-count enforcement after the provider schema drops minItems/maxItems",
  );
  let analysisCalls = 0;
  let edited = false;
  let meaningShift = false;
  let analyzedWindowCount = 0;
  const analyzer = {
    async analyze(input: { windows: Array<{ text: string }> }) {
      analysisCalls += 1;
      analyzedWindowCount = input.windows.length;
      return completeAnalysis({
        contentDomain: "personal finance",
        suggestedVisualFormatId: "clear-infographic" as const,
        suggestedTreatment: { label: "ชัด กระชับ น่าเชื่อถือ", mood: "professional" },
        beats: [
          {
            beatKey: "window-0",
            sourceExcerpt: edited
              ? "เก็บเงินก้อนแรกให้ได้ด้วยการโอนอัตโนมัติ"
              : "เก็บเงินก้อนแรกให้ได้ด้วยวิธีนี้",
            subject: "a first-jobber and a savings jar",
            action: edited ? "sets one automatic transfer on a phone" : "places one coin into the jar",
            setting: "a small apartment desk",
            emotion: "hopeful focus",
            emphasis: "the first repeatable saving action",
          },
          {
            beatKey: "window-1",
            sourceExcerpt: "เริ่มวันนี้แล้วทำต่อทุกเดือน",
            subject: meaningShift ? "a payroll team and a mandatory deduction calendar" : "the same first-jobber and a calendar rhythm",
            action: meaningShift ? "changes the rule behind the monthly transfer" : "repeats the saving habit",
            setting: "the same apartment desk",
            emotion: "confident momentum",
            emphasis: "consistent monthly action",
          },
        ],
      });
    },
  };

  const request = {
    userId: user.id,
    projectId: project.id,
    narrativeSource: {
      kind: "creator-script" as const,
      text: "เก็บเงินก้อนแรกให้ได้ด้วยวิธีนี้\nเริ่มวันนี้แล้วทำต่อทุกเดือน",
      windows: [
        { text: "เก็บเงินก้อนแรกให้ได้ด้วยวิธีนี้" },
        { text: "เริ่มวันนี้แล้วทำต่อทุกเดือน" },
      ],
    },
    analyzer,
  };
  const first = await resolveContentPreflight(request);
  const cached = await resolveContentPreflight(request);

  assert.equal(analysisCalls, 1, "opening multiple AI visual surfaces must reuse one lazy analysis");
  assert.equal(cached.id, first.id);
  assert.equal(first.visualBeats.length, 2);
  assert.equal(analyzedWindowCount, 2, "the analyzer receives the authoritative B-roll window plan");
  assert.equal(await prisma.contentPreflight.count(), 1);

  // Scene content policy is part of immutable preflight/asset identity. The
  // same story with a new people/location choice must be re-analyzed, compiled
  // into the beat, and must never reuse the old image as current.
  const policyProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Scene content policy" },
  });
  let policyAnalysisCalls = 0;
  const policyAnalyzer = {
    async analyze() {
      policyAnalysisCalls += 1;
      return completeAnalysis({
        contentDomain: "creator workflow",
        suggestedVisualFormatId: "simple-editorial-story" as const,
        suggestedTreatment: { label: "clear", mood: "encouraging" },
        beats: [{
          beatKey: "window-0",
          sourceExcerpt: "A founder explains one useful workflow in a coffee shop.",
          subject: "a founder and a laptop",
          action: "the founder points to one useful workflow",
          setting: "a neighborhood coffee shop",
          emotion: "focused optimism",
          emphasis: "the practical workflow",
        }],
      });
    },
  };
  const policyNarrative = "A founder explains one useful workflow in a coffee shop.";
  const defaultPolicyPreflight = await resolveContentPreflight({
    userId: user.id,
    projectId: policyProject.id,
    narrativeSource: { kind: "creator-script", text: policyNarrative, windowCount: 1 },
    analyzer: policyAnalyzer,
  });
  const policyImageJob = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "/api/generated/default-policy.webp",
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
    },
  });
  await recordVisualBeatAsset({
    userId: user.id,
    beatId: defaultPolicyPreflight.visualBeats[0].id,
    outputUrl: "/api/generated/default-policy.webp",
    imageJobId: policyImageJob.id,
    identityKey: "default-scene-policy-v1",
  });
  const thaiPolicyPreflight = await resolveContentPreflight({
    userId: user.id,
    projectId: policyProject.id,
    previousPreflightId: defaultPolicyPreflight.id,
    narrativeSource: {
      kind: "creator-script",
      text: policyNarrative,
      windowCount: 1,
      sceneContentPolicy: "thai",
    },
    analyzer: policyAnalyzer,
  });
  assert.notEqual(thaiPolicyPreflight.id, defaultPolicyPreflight.id);
  assert.equal(thaiPolicyPreflight.sceneContentPolicy.locale, "thai");
  assert.match(thaiPolicyPreflight.visualBeats[0].subject, /Thai or Southeast Asian/);
  assert.match(thaiPolicyPreflight.visualBeats[0].setting, /Thai local context/);
  assert.equal(thaiPolicyPreflight.visualBeats[0].existingAssetUrl, "/api/generated/default-policy.webp");
  assert.equal(
    thaiPolicyPreflight.visualBeats[0].status,
    "outdated",
    "a locale change may preserve lineage but can never serve the previous image as current",
  );
  const cachedThaiPolicy = await resolveContentPreflight({
    userId: user.id,
    projectId: policyProject.id,
    previousPreflightId: defaultPolicyPreflight.id,
    narrativeSource: {
      kind: "creator-script",
      text: policyNarrative,
      windowCount: 1,
      sceneContentPolicy: "thai",
    },
    analyzer: policyAnalyzer,
  });
  assert.equal(cachedThaiPolicy.id, thaiPolicyPreflight.id);
  assert.equal(policyAnalysisCalls, 2, "the exact same policy reuses its immutable analysis");

  const noPeoplePreflight = await resolveContentPreflight({
    userId: user.id,
    projectId: policyProject.id,
    previousPreflightId: thaiPolicyPreflight.id,
    narrativeSource: {
      kind: "creator-script",
      text: policyNarrative,
      windowCount: 1,
      sceneContentPolicy: "no-people",
    },
    analyzer: policyAnalyzer,
  });
  assert.equal(noPeoplePreflight.sceneContentPolicy.people, "avoid-visible-people");
  assert.equal(noPeoplePreflight.visualBeats[0].policyFallbackApplied, true);
  assert.doesNotMatch(
    [
      noPeoplePreflight.visualBeats[0].subject,
      noPeoplePreflight.visualBeats[0].action,
      noPeoplePreflight.visualBeats[0].setting,
      noPeoplePreflight.visualBeats[0].emphasis,
    ].join(" "),
    /\b(?:founder|person|people|man|woman|crowd|team)\b/i,
  );

  const settledHookJob = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "/api/generated/old-hook.webp",
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
    },
  });
  const settledCloseJob = await prisma.aiGenerationJob.create({
    data: {
      userId: user.id,
      kind: "image",
      provider: "runpod",
      model: "z-image",
      status: "completed",
      outputUrl: "/api/generated/unchanged-close.webp",
      fundingSource: "credits",
      chargeState: "settled",
      creditCost: 2,
    },
  });
  await recordVisualBeatAsset({
    userId: user.id,
    beatId: first.visualBeats[0].id,
    outputUrl: "/api/generated/old-hook.webp",
    imageJobId: settledHookJob.id,
    identityKey: "content-preflight-identity-v1",
  });
  await recordVisualBeatAsset({
    userId: user.id,
    beatId: first.visualBeats[1].id,
    outputUrl: "/api/generated/unchanged-close.webp",
    imageJobId: settledCloseJob.id,
    identityKey: "content-preflight-identity-v1",
  });
  edited = true;
  const afterEdit = await resolveContentPreflight({
    ...request,
    narrativeSource: {
      ...request.narrativeSource,
      text: "เก็บเงินก้อนแรกให้ได้ด้วยการโอนอัตโนมัติ\nเริ่มวันนี้แล้วทำต่อทุกเดือน",
      windows: [
        { text: "เก็บเงินก้อนแรกให้ได้ด้วยการโอนอัตโนมัติ" },
        { text: "เริ่มวันนี้แล้วทำต่อทุกเดือน" },
      ],
    },
  });
  assert.equal(afterEdit.visualBeats.filter((beat) => beat.status === "outdated").length, 1);
  assert.equal(afterEdit.visualBeats[0].existingAssetUrl, "/api/generated/old-hook.webp");
  assert.equal(afterEdit.visualBeats[1].status, "current");
  assert.equal(afterEdit.visualBeats[1].existingAssetUrl, "/api/generated/unchanged-close.webp");

  const videoJob = await prisma.videoJob.create({
    data: {
      userId: user.id,
      projectId: project.id,
      contentPreflightId: afterEdit.id,
      projectVisualContextJson: JSON.stringify({
        source: "suggested",
        visualFormatId: "clear-infographic",
        recipeVersion: "clear-infographic-v2",
        treatment: "clear",
        brandVisualLanguage: null,
      }),
      inputJson: "{}",
    },
  });
  const reusable = await reusableVisualBeatAssetsForVideoJob({
    userId: user.id,
    videoJobId: videoJob.id,
  });
  assert.deepEqual(
    reusable.map(({ sceneIndex, outputUrl }) => ({ sceneIndex, outputUrl })),
    [{ sceneIndex: 1, outputUrl: "/api/generated/unchanged-close.webp" }],
    "the next confirmed render must reuse only unchanged current beats",
  );

  meaningShift = true;
  const semanticEdit = await resolveContentPreflight({
    ...request,
    narrativeSource: {
      ...request.narrativeSource,
      text: "กฎบริษัทเปลี่ยนบริบทของคำแนะนำ\nเก็บเงินก้อนแรกให้ได้ด้วยการโอนอัตโนมัติ\nเริ่มวันนี้แล้วทำต่อทุกเดือน",
      windows: [
        { text: "เก็บเงินก้อนแรกให้ได้ด้วยการโอนอัตโนมัติ" },
        { text: "เริ่มวันนี้แล้วทำต่อทุกเดือน" },
      ],
    },
  });
  assert.equal(
    semanticEdit.visualBeats[1].status,
    "current",
    "analyzer paraphrasing alone cannot invalidate an unchanged authoritative source window",
  );

  // Exercise the production planner path (text + windowCount, no hand-aligned
  // windows). The second request explicitly names its lineage so another tab's
  // newer preflight cannot become the carry-forward source.
  const alignmentProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Stable window alignment" },
  });
  const alignmentAnalyzer = {
    async analyze(input: { windows: Array<{ text: string }> }) {
      return completeAnalysis({
        contentDomain: "creator workflow",
        suggestedVisualFormatId: "simple-editorial-story" as const,
        suggestedTreatment: { label: "clear", mood: "focused" },
        beats: input.windows.map((window, index) => ({
          beatKey: `window-${index}`,
          sourceExcerpt: window.text,
          subject: `creator scene ${index + 1}`,
          action: "shows one concrete step",
          setting: "a practical creator workspace",
          emotion: "focused confidence",
          emphasis: "the current step",
        })),
      });
    },
  };
  const alignmentFirst = await resolveContentPreflight({
    userId: user.id,
    projectId: alignmentProject.id,
    narrativeSource: {
      kind: "creator-script",
      text: stableWindowSource,
      windowCount: 3,
    },
    analyzer: alignmentAnalyzer,
  });
  for (const [index, beat] of alignmentFirst.visualBeats.entries()) {
    const imageJob = await prisma.aiGenerationJob.create({
      data: {
        userId: user.id,
        kind: "image",
        provider: "runpod",
        model: "z-image",
        status: "completed",
        outputUrl: `/api/generated/aligned-${index}.webp`,
        fundingSource: "credits",
        chargeState: "settled",
        creditCost: 2,
      },
    });
    await recordVisualBeatAsset({
      userId: user.id,
      beatId: beat.id,
      outputUrl: `/api/generated/aligned-${index}.webp`,
      imageJobId: imageJob.id,
      identityKey: "stable-alignment-identity",
    });
  }
  const alignmentAfterPrefix = await resolveContentPreflight({
    userId: user.id,
    projectId: alignmentProject.id,
    previousPreflightId: alignmentFirst.id,
    narrativeSource: {
      kind: "creator-script",
      text: `เกริ่นสั้นๆ ${stableWindowSource}`,
      windowCount: 3,
    },
    analyzer: alignmentAnalyzer,
  });
  assert.deepEqual(
    alignmentAfterPrefix.visualBeats.map((beat) => ({
      status: beat.status,
      asset: beat.existingAssetUrl,
    })),
    [
      { status: "outdated", asset: "/api/generated/aligned-0.webp" },
      { status: "current", asset: "/api/generated/aligned-1.webp" },
      { status: "current", asset: "/api/generated/aligned-2.webp" },
    ],
    "production text+windowCount planning regenerates only the locally changed Visual Beat",
  );

  // A cached narrative must still reconcile assets from the caller's exact
  // lineage. This covers A -> B (cached before images) -> A gains images -> B.
  const cacheRebaseProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Cached lineage asset rebase" },
  });
  const cacheRebaseAnalyzer = {
    async analyze(input: { windows: Array<{ text: string }> }) {
      return completeAnalysis({
        contentDomain: "creator workflow",
        suggestedVisualFormatId: "clear-infographic" as const,
        suggestedTreatment: { label: "clear", mood: "focused" },
        beats: input.windows.map((window, index) => ({
          beatKey: `window-${index}`,
          sourceExcerpt: window.text,
          subject: `shared scene ${index + 1}`,
          action: "shows one durable step",
          setting: "creator desk",
          emotion: "focused",
          emphasis: "the shared source window",
        })),
      });
    },
  };
  const cacheA = await resolveContentPreflight({
    userId: user.id,
    projectId: cacheRebaseProject.id,
    narrativeSource: {
      kind: "creator-script",
      text: "context A",
      windows: [{ text: "shared one" }, { text: "shared two" }],
    },
    analyzer: cacheRebaseAnalyzer,
  });
  const cacheB = await resolveContentPreflight({
    userId: user.id,
    projectId: cacheRebaseProject.id,
    previousPreflightId: cacheA.id,
    narrativeSource: {
      kind: "creator-script",
      text: "context B",
      windows: [{ text: "shared one" }, { text: "shared two" }],
    },
    analyzer: cacheRebaseAnalyzer,
  });
  const cacheAsset = async (beatId: string, outputUrl: string, identityKey: string) => {
    const imageJob = await prisma.aiGenerationJob.create({
      data: {
        userId: user.id,
        kind: "image",
        provider: "runpod",
        model: "z-image",
        status: "completed",
        outputUrl,
        fundingSource: "credits",
        chargeState: "settled",
        creditCost: 2,
      },
    });
    await recordVisualBeatAsset({
      userId: user.id,
      beatId,
      outputUrl,
      imageJobId: imageJob.id,
      identityKey,
    });
  };
  await cacheAsset(cacheA.visualBeats[0].id, "/api/generated/cache-a-0.webp", "cache-a");
  await cacheAsset(cacheA.visualBeats[1].id, "/api/generated/cache-a-1.webp", "cache-a");
  await cacheAsset(cacheB.visualBeats[1].id, "/api/generated/cache-b-own.webp", "cache-b");
  const cacheBRebased = await resolveContentPreflight({
    userId: user.id,
    projectId: cacheRebaseProject.id,
    previousPreflightId: cacheA.id,
    narrativeSource: {
      kind: "creator-script",
      text: "context B",
      windows: [{ text: "shared one" }, { text: "shared two" }],
    },
    analyzer: cacheRebaseAnalyzer,
  });
  assert.equal(cacheBRebased.cached, true);
  assert.deepEqual(
    cacheBRebased.visualBeats.map((beat) => beat.existingAssetUrl),
    ["/api/generated/cache-a-0.webp", "/api/generated/cache-b-own.webp"],
    "a cache hit rebases exact unchanged assets while preserving the cached preflight's own current asset",
  );

  const { ensureUploadContentPreflight } = await import("../src/lib/upload-content-preflight.server");
  const productionReplayProject = await prisma.editorProject.create({
    data: { userId: user.id, title: "Upload semantic repair replay" },
  });
  const productionReplayEntities = [
    {
      entityId: "andrew",
      properName: "Andrew",
      entityType: "person",
      durableAttributes: ["adult Australian man"],
      renderingDescription: "Andrew, an adult Australian man in casual sportswear",
      recurringCharacterDescription: "Andrew, the same adult Australian man in casual sportswear",
      isRealPerson: false,
    },
    {
      entityId: "openclaw",
      properName: "OpenClaw",
      entityType: "object",
      durableAttributes: ["local AI automation tool"],
      renderingDescription: "OpenClaw, a local AI automation tool on a computer",
      recurringCharacterDescription: "OpenClaw, the same local AI automation tool",
      isRealPerson: false,
    },
    {
      entityId: "ai-assistant",
      properName: "AI Assistant",
      entityType: "object",
      durableAttributes: ["autonomous browser software"],
      renderingDescription: "AI Assistant with autonomous browser access",
      recurringCharacterDescription: "AI Assistant controlling the same browser workflow",
      isRealPerson: false,
    },
    {
      entityId: "booking-system",
      properName: "Gym Booking System",
      entityType: "object",
      durableAttributes: ["class reservation software"],
      renderingDescription: "Gym Booking System showing a class queue",
      recurringCharacterDescription: null,
      isRealPerson: false,
    },
    {
      entityId: "software-company",
      properName: "Software Company",
      entityType: "object",
      durableAttributes: ["booking platform vendor"],
      renderingDescription: "Software Company receiving a vulnerability report",
      recurringCharacterDescription: "Software Company reviewing the report",
      isRealPerson: false,
    },
    {
      entityId: "abcn-news",
      properName: "ABCN News",
      entityType: "object",
      durableAttributes: ["Australian news organization"],
      renderingDescription: "ABCN News reporting the automated cyber incident",
      recurringCharacterDescription: "ABCN News newsroom covering the incident",
      isRealPerson: false,
    },
  ];
  const productionReplayAnalysis = {
    ...validEightBeatAnalysis,
    contentDomain: "AI assistant security and booking-system governance",
    storyEntities: productionReplayEntities,
    beats: validEightBeatAnalysis.beats.map((beat, index) => {
      const refs = index === 0
        ? ["andrew", "openclaw", "abcn-news"]
        : index <= 3
          ? ["andrew", "openclaw", "ai-assistant", "booking-system"]
          : index === 4
            ? ["andrew", "ai-assistant", "software-company"]
            : ["ai-assistant", "booking-system"];
      return {
        ...beat,
        subject: index === 0
          ? "Andrew asks OpenClaw to reserve a gym class while ABCN News frames the incident"
          : "Andrew watches the AI Assistant interact with the Gym Booking System",
        action: index === 4
          ? "Andrew asks the AI Assistant to notify the Software Company"
          : "the AI Assistant changes a queue position in the Gym Booking System",
        emphasis: "OpenClaw and the AI Assistant expose the one-way booking flaw",
        hardSceneFacts: {
          ...beat.hardSceneFacts,
          entityTypes: ["Andrew", "AI Assistant", "Gym Booking System"],
          actions: ["the AI Assistant changes the Gym Booking System queue"],
          essentialObjects: ["OpenClaw interface"],
        },
        entityRefs: refs,
      };
    }),
  };
  let productionReplayProviderCalls = 0;
  const productionReplayAnalyzer = createGeminiContentPreflightAnalyzer(
    user.id,
    async () => {
      productionReplayProviderCalls += 1;
      return JSON.stringify(productionReplayAnalysis);
    },
  );
  const productionReplay = await ensureUploadContentPreflight({
    actor: user,
    projectId: productionReplayProject.id,
    transcriptText: eightWindows.map((window) => window.text).join("\n"),
    windows: eightWindows,
    brandVisualAccepted: true,
  }, {
    resolve: resolveContentPreflight,
    createAnalyzer: () => productionReplayAnalyzer,
  });
  assert.equal(productionReplay.kind, "resolved");
  if (productionReplay.kind !== "resolved") throw new Error("upload preflight did not resolve");
  assert.equal(productionReplayProviderCalls, 1,
    "the production-shaped upload analysis resolves without exhausting provider retries");
  assert.equal(productionReplay.preflight.visualBeats.length, 8);
  assert.deepEqual(
    productionReplay.preflight.storyEntities.map((entity) => entity.properName),
    ["Andrew", "OpenClaw", "ABCN News"],
    "generic roles are removed while genuine named story entities remain linked",
  );
  const providerFacingReplay = productionReplay.preflight.visualBeats.map((beat) => ({
    subject: beat.subject,
    action: beat.action,
    setting: beat.setting,
    emotion: beat.emotion,
    emphasis: beat.emphasis,
    hardSceneFacts: beat.hardSceneFacts,
  }));
  assert.doesNotMatch(
    JSON.stringify(providerFacingReplay),
    /Andrew|OpenClaw|ABCN News/i,
    "proper names stay internal and cannot leak into the image provider fields",
  );
  assert.ok(
    productionReplay.preflight.storyEntities.every((entity) => (
      !entity.renderingDescription.toLocaleLowerCase().includes(entity.properName.toLocaleLowerCase())
      && !entity.recurringCharacterDescription?.toLocaleLowerCase().includes(entity.properName.toLocaleLowerCase())
    )),
    "retained entity descriptions are provider-safe",
  );
  const priorRollout = {
    BRAND_VISUAL_SYSTEM_ENABLED: process.env.BRAND_VISUAL_SYSTEM_ENABLED,
    BRAND_VISUAL_ROLLOUT_PERCENT: process.env.BRAND_VISUAL_ROLLOUT_PERCENT,
    BRAND_VISUAL_ROLLOUT_STARTED_AT: process.env.BRAND_VISUAL_ROLLOUT_STARTED_AT,
  };
  process.env.BRAND_VISUAL_SYSTEM_ENABLED = "1";
  process.env.BRAND_VISUAL_ROLLOUT_PERCENT = "100";
  process.env.BRAND_VISUAL_ROLLOUT_STARTED_AT = "2026-08-01T00:00:00.000Z";
  try {
    const calls: Array<{ kind: string; text: string; projectId: string; windowCount: number }> = [];
    const result = await ensureUploadContentPreflight({
      actor: {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
      projectId: project.id,
      transcriptText: "เสียงจากคลิปอัปโหลดที่ถอดแล้ว",
      windows: [{ text: "ช่วงภาพแรก", startMs: 0, endMs: 4_000 }],
    }, {
      resolve: async (input) => {
        calls.push({
          kind: input.narrativeSource.kind,
          text: input.narrativeSource.text,
          projectId: input.projectId,
          windowCount: input.narrativeSource.windows?.length ?? 0,
        });
        return first;
      },
      createAnalyzer: () => analyzer,
    });
    assert.equal(result.kind, "resolved");
    assert.deepEqual(calls, [{
      kind: "upload-transcript",
      text: "เสียงจากคลิปอัปโหลดที่ถอดแล้ว",
      projectId: project.id,
      windowCount: 1,
    }]);

    process.env.BRAND_VISUAL_SYSTEM_ENABLED = "0";
    const acceptedBeforeFlagChange = await ensureUploadContentPreflight({
      actor: {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
      projectId: project.id,
      transcriptText: "งานนี้รับสิทธิ์ไว้ก่อนปิด flag",
      brandVisualAccepted: true,
    }, {
      resolve: async () => first,
      createAnalyzer: () => analyzer,
    });
    assert.equal(acceptedBeforeFlagChange.kind, "resolved",
      "an accepted upload keeps its treatment snapshot when rollout flags change in queue");
    process.env.BRAND_VISUAL_SYSTEM_ENABLED = "1";
    const rejectedBeforeFlagChange = await ensureUploadContentPreflight({
      actor: {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
      projectId: project.id,
      transcriptText: "งาน control ห้ามถูกเปิดระหว่างรอคิว",
      brandVisualAccepted: false,
    }, {
      resolve: async () => { throw new Error("acceptance-time control must stay control"); },
      createAnalyzer: () => analyzer,
    });
    assert.deepEqual(rejectedBeforeFlagChange, { kind: "skipped", reason: "not-in-treatment" });

    const control = await ensureUploadContentPreflight({
      actor: {
        id: "pre-rollout-user",
        email: "pre-rollout@example.test",
        role: "USER",
        createdAt: new Date("2026-07-31T00:00:00.000Z"),
      },
      projectId: project.id,
      transcriptText: "ไม่ควรวิเคราะห์ใน control",
    }, {
      resolve: async () => { throw new Error("control must not call analyzer"); },
      createAnalyzer: () => analyzer,
    });
    assert.deepEqual(control, { kind: "skipped", reason: "not-in-treatment" });
  } finally {
    for (const [name, value] of Object.entries(priorRollout)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const orchestratorSource = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
  const uploadBranch = orchestratorSource.slice(orchestratorSource.indexOf('if (input.mode === "upload")'));
  assert.ok(
    uploadBranch.indexOf("await ensureUploadContentPreflight({") >= 0
      && uploadBranch.indexOf("await ensureUploadContentPreflight({") < uploadBranch.indexOf('await step("keywords", 40)'),
    "upload transcript preflight must resolve before keyword/image generation",
  );
  const scriptWindowBranch = orchestratorSource.slice(orchestratorSource.indexOf("const pinnedBrandVisualWindows"));
  assert.ok(
    scriptWindowBranch.includes("await narrativeVisualWindowsForPreflight({")
      && scriptWindowBranch.includes("buildNarrativeAlignedBrollWindows({")
      && scriptWindowBranch.indexOf("buildNarrativeAlignedBrollWindows({")
        < scriptWindowBranch.indexOf('await step("keywords", 40)'),
    "script renders must lay the exact accepted Narrative windows onto TTS timing before keyword/image generation",
  );

  const selectorSource = readFileSync("src/app/(dashboard)/video-editor/_v2/BrandVisualSelector.tsx", "utf8");
  assert.ok(
    selectorSource.includes('const canLoadWithoutNarrative = p.mode === "upload";')
      && selectorSource.includes("if (!narrative && !canLoadWithoutNarrative)"),
    "upload mode must expose Brand Profile/Project Look before a transcript exists",
  );
  const step2Source = readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
  assert.ok(
    selectorSource.includes("onPreflightStatusChange")
      && selectorSource.includes('onPreflightStatusChange?.("loading")')
      && selectorSource.includes('onPreflightStatusChange?.("ready")')
      && selectorSource.includes('onPreflightStatusChange?.("error")'),
    "Brand Visual selector must report preflight lifecycle to the render owner",
  );
  const preflightRouteSource = readFileSync(
    "src/app/api/editor-projects/[id]/content-preflight/route.ts",
    "utf8",
  );
  assert.ok(
    selectorSource.includes("previousPreflightId: preflight?.id")
      && preflightRouteSource.includes("previousPreflightId")
      && preflightRouteSource.includes("previousPreflightId,"),
    "selective carry-forward must bind to the caller's exact prior preflight, not another tab's latest row",
  );
  assert.ok(
    step2Source.includes("requiresBrandPreflight")
      && step2Source.includes('p.mode !== "upload"')
      && step2Source.includes('p.brollSource === "kie-image"')
      && step2Source.includes('p.brollSource === "automix" && p.mixPreset !== "free"')
      && step2Source.includes("brandPreflightStatus !== \"ready\"")
      && step2Source.includes("const brandRenderBlocked = brandSelectionBlocked;")
      && step2Source.includes("disabled={submitting || brandRenderBlocked}"),
    "render acceptance waits only for an unfinished creator selection; Content Preflight may finish in the worker",
  );

  await prisma.$disconnect();
  console.log("verify-content-preflight: PASS lazy cache + selective staleness + upload transcript integration");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
