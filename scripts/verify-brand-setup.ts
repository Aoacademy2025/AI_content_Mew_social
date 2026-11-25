import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "brand-setup-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { env: process.env, stdio: "ignore" });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { completeBrandSetup } = await import("../src/lib/brand-setup.server");
  const { createBrandSetupSeed, brandPreviewInputKey, nextBrandName } = await import("../src/lib/brand-setup");
  const { createBlankBrandProfileSeed } = await import("../src/lib/brand-profile-seed");
  const storageState = await import("../src/lib/brand-setup-client-state");
  const blank = createBlankBrandProfileSeed();
  const { stylePack } = await import("../src/lib/style-pack-catalog");
  const defaults = { script: { styleId: null, tone: "โทนที่เจ้าของเขียนเอง", analysisNotes: null, sampleText: null }, voice: { provider: "gemini" as const, voiceId: "Kore" }, subtitle: { presetId: "authored-style", config: { ...stylePack("life-drama").subtitle, fontFamily: "Sarabun", fontSize: 62 } }, brandMark: blank.brandMark };
  const payload = createBrandSetupSeed(defaults, ["แบรนด์ของฉัน"]);
  assert.equal(payload.name, "แบรนด์ของฉัน 2");
  assert.equal(payload.voice.voiceId, "Kore");
  assert.equal(payload.subtitle.presetId, "authored-style");
  assert.equal(payload.script.tone, defaults.script.tone);
  assert.equal(payload.visual.defaultBrollSource, "stock", "new Brand Kit starts on 0-credit stock instead of surprise paid AI images");
  const unowned = createBrandSetupSeed({ ...defaults, script: { styleId: null, tone: blank.script.tone, analysisNotes: null, sampleText: null } }, []);
  assert.equal(unowned.script.tone, stylePack("life-drama").scriptTone, "unowned server defaults acquire the selected pack's writing tone");
  assert.equal(nextBrandName(["แบรนด์ของฉัน", "แบรนด์ของฉัน 2"]), "แบรนด์ของฉัน 3");
  assert.equal(brandPreviewInputKey(payload), brandPreviewInputKey({ ...payload, name: "rename" }));
  assert.equal(
    brandPreviewInputKey(payload),
    brandPreviewInputKey({ ...payload, visual: { ...payload.visual, defaultBrollSource: "motion", motionThemeId: "apple-bento-glass" } }),
    "changing B-roll source or motion theme does not invalidate AI look preview input key",
  );
  assert.notEqual(brandPreviewInputKey(payload), brandPreviewInputKey({ ...payload, visual: { ...payload.visual, palette: ["#FFFFFF"] } }));

  const owner = await prisma.user.create({ data: { name: "Owner", email: "setup-owner@example.test", plan: "BUSINESS" } });
  const other = await prisma.user.create({ data: { name: "Other", email: "setup-other@example.test", plan: "FREE" } });
  const request = { requestId: randomUUID(), action: "create-clip" as const, payload };
  const result = await completeBrandSetup(owner.id, request, null);
  const replay = await completeBrandSetup(owner.id, request, null);
  assert.equal(result.projectId, replay.projectId);
  assert.equal(replay.replayed, true);
  assert.equal(await prisma.brandProfile.count({ where: { userId: owner.id } }), 1);
  assert.equal(await prisma.editorProject.count({ where: { userId: owner.id } }), 1);
  const project = await prisma.editorProject.findUniqueOrThrow({ where: { id: result.projectId! } });
  assert.equal(project.brandProfileRevisionId, result.revisionId);
  assert.equal(project.brandVisualPinAdmittedCohort, null, "library setup must not admit AI images");
  const draft = JSON.parse(project.draftJson!);
  assert.equal(draft.geminiVoiceName, "Kore");
  assert.equal(draft.brollSource, "stock", "unadmitted stock Brand Kit starts on 0-credit stock");
  assert.equal(draft.templateId, "life-drama", "Style Pack propagates templateId to Editor draft");
  assert.equal(draft.brollTransition, stylePack("life-drama").brollTransition, "Style Pack propagates brollTransition");
  assert.equal(draft.brandSubtitleDefault.fontFamily, "Sarabun");
  assert.equal(draft.script, "");
  assert.equal(project.activeJobId, null, "setup never starts a render");
  await assert.rejects(() => completeBrandSetup(owner.id, { ...request, payload: { ...payload, name: "different" } }, null), /ข้อมูลอีกชุด/);
  await assert.rejects(() => completeBrandSetup(other.id, { requestId: randomUUID(), action: "use-brand", profileId: result.profileId, revisionId: result.revisionId }, null), /ไม่พบแบรนด์/);

  // Motion B-Roll Brand Kit propagates motionThemeId + motionMascot + 0-credit stock source + HERO-94 defaults.
  const motionPayload = {
    ...payload,
    name: "Motion Channel",
    voice: { ...payload.voice, geminiVoiceStyle: "energetic", ttsSpeed: 1.1 },
    visual: {
      ...payload.visual,
      defaultBrollSource: "motion" as const,
      motionThemeId: "apple-bento-glass" as const,
      motionMascot: "ai-bot" as const,
    },
    videoDefaults: {
      headlineHookEnabled: true,
      headlineHookPreset: "stat-burst" as const,
      highlightKeywords: true,
      statCards: true,
      sfxMode: "subtle" as const,
      punchZoom: true,
      brollTransition: "cut" as const,
      musicMood: "upbeat" as const,
    },
  };
  const motionSetup = await completeBrandSetup(owner.id, { requestId: randomUUID(), action: "create-clip", payload: motionPayload }, null);
  const motionProject = await prisma.editorProject.findUniqueOrThrow({ where: { id: motionSetup.projectId! } });
  const motionDraft = JSON.parse(motionProject.draftJson!);
  assert.equal(motionDraft.brollSource, "stock");
  assert.equal(motionDraft.motionThemeId, "apple-bento-glass");
  assert.equal(motionDraft.motionMascot, "ai-bot");
  assert.equal(motionDraft.geminiVoiceStyle, "energetic");
  assert.equal(motionDraft.ttsSpeed, 1.1);
  assert.equal(motionDraft.sfxMode, "subtle");
  assert.equal(motionDraft.punchZoom, true);
  assert.equal(motionDraft.brollTransition, "cut");
  assert.equal(motionDraft.brandSubtitleDefault.highlightKeywords, true);
  assert.equal(motionDraft.brandSubtitleDefault.statCards, true);

  // kie-image Brand Kit clamps to stock when unadmitted, and keeps kie-image when admitted.
  const aiBrandPayload = { ...payload, name: "AI Visual Brand", visual: { ...payload.visual, defaultBrollSource: "kie-image" as const } };
  const unadmittedAi = await completeBrandSetup(owner.id, { requestId: randomUUID(), action: "create-clip", payload: aiBrandPayload }, null);
  const unadmittedDraft = JSON.parse((await prisma.editorProject.findUniqueOrThrow({ where: { id: unadmittedAi.projectId! } })).draftJson!);
  assert.equal(unadmittedDraft.brollSource, "stock", "unadmitted kie-image brand safely clamps to stock");
  const admittedAi = await completeBrandSetup(
    owner.id,
    { requestId: randomUUID(), action: "create-clip", payload: { ...aiBrandPayload, name: "AI Visual Brand Admitted" } },
    { cohort: "internal", rolloutBucket: 0 },
  );
  const admittedDraft = JSON.parse((await prisma.editorProject.findUniqueOrThrow({ where: { id: admittedAi.projectId! } })).draftJson!);
  assert.equal(admittedDraft.brollSource, "kie-image", "admitted kie-image brand keeps Hero AI Image default");

  const save = { requestId: randomUUID(), action: "save" as const, profileId: result.profileId, expectedRevision: 1, payload: { ...payload, name: "updated" } };
  const updated = await completeBrandSetup(owner.id, save, null);
  assert.equal(updated.revision, 2);
  assert.equal((await completeBrandSetup(owner.id, save, null)).revision, 2);
  await assert.rejects(() => completeBrandSetup(owner.id, { ...save, requestId: randomUUID() }, null), /เวอร์ชันใหม่กว่า/);
  assert.equal((await prisma.editorProject.findUniqueOrThrow({ where: { id: result.projectId! } })).brandProfileRevisionId, result.revisionId, "publishing never moves an existing clip");

  const race = { requestId: randomUUID(), action: "create-clip" as const, payload };
  const raced = await Promise.all([completeBrandSetup(owner.id, race, null), completeBrandSetup(owner.id, race, null)]);
  assert.equal(raced[0].projectId, raced[1].projectId, "concurrent requests deduplicate");

  const countBefore = await prisma.brandProfile.count({ where: { userId: owner.id } });
  const broken = { requestId: randomUUID(), action: "create-clip", payload: { ...payload, brandMark: { ...payload.brandMark, assetId: "deleted-or-foreign", enabled: true } } };
  await assert.rejects(() => completeBrandSetup(owner.id, broken, null), /โลโก้/);
  assert.equal(await prisma.brandProfile.count({ where: { userId: owner.id } }), countBefore, "invalid asset rolls back profile creation");
  assert.equal(await prisma.brandLibraryOperation.count({ where: { userId: owner.id, requestId: broken.requestId } }), 0);
  await assert.rejects(() => completeBrandSetup(owner.id, { requestId: randomUUID(), action: "save", payload: { ...payload, voice: { provider: "gemini", voiceId: "retired-voice" } } }, null), /เสียง/);
  await assert.rejects(() => completeBrandSetup(other.id, { requestId: randomUUID(), action: "create-clip", payload: { ...payload, voice: { provider: "elevenlabs", voiceId: "saved-before-downgrade" } } }, null), /ElevenLabs/);
  assert.equal(await prisma.brandProfile.count({ where: { userId: other.id } }), 0, "an inaccessible voice cannot consume a FREE brand slot");
  const free = await completeBrandSetup(other.id, { requestId: randomUUID(), action: "create-clip", payload }, null);
  assert.ok(free.projectId, "FREE may create a brand and a project");
  await assert.rejects(() => completeBrandSetup(other.id, { requestId: randomUUID(), action: "save", payload }, null), /บันทึกแบรนด์ได้/);

  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
  storageState.writeBrandSetupDraft(storage, { userId: owner.id, profileId: null, projectId: null, payload, expectedRevision: null, savedAt: Date.now() });
  assert.equal(storageState.readBrandSetupDraft(storage, owner.id, null, null)?.payload.name, payload.name);
  assert.equal(storageState.readBrandSetupDraft(storage, other.id, null, null), null);
  assert.equal(storageState.readBrandSetupDraft(storage, owner.id, result.profileId, null), null);
  storageState.writeBrandSetupRequest(storage, owner.id, request);
  assert.deepEqual(storageState.readBrandSetupRequest(storage, owner.id), request);
  assert.equal(storageState.readBrandSetupRequest(storage, other.id), null);
  storageState.writeBrandSetupReceipt(storage, owner.id, result);
  assert.equal(storageState.readBrandSetupReceipt(storage, owner.id)?.projectId, result.projectId);
  assert.equal(storageState.readBrandSetupReceipt(storage, other.id), null);
  assert.equal(storageState.isBrandSetupResult({ profileId: "x" }), false);
  storageState.writeBrandSetupDraft(storage, { userId: owner.id, profileId: null, projectId: null, payload, expectedRevision: null, savedAt: Date.now() - 8 * 86400000 });
  assert.equal(storageState.readBrandSetupDraft(storage, owner.id, null, null), null);
  values.set(storageState.brandSetupDraftKey(owner.id, null, null), '{"payload":null}');
  assert.equal(storageState.readBrandSetupDraft(storage, owner.id, null, null), null);
  console.log("verify-brand-setup: 0-credit default, Motion + HERO-94 propagation, admission clamping, replay, concurrent retry, ownership, revision conflict, FREE cap, exact pin, no render, and recovery PASS");
  await prisma.$disconnect();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
