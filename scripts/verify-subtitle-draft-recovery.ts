// Run: npx tsx scripts/verify-subtitle-draft-recovery.ts
// HERO-116 (Phase A1): verifies post-phase subtitle dirty detection, per-job localStorage
// persistence/re-keying, SecurityError/QuotaExceededError safety, B-roll rebase race guard,
// and desktop/mobile restore banner wiring (including "แก้ซับต่อ").

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SUBTITLE_DRAFT_MAX_BYTES,
  SUBTITLE_DRAFT_RESTORE_COPY,
  SUBTITLE_DRAFT_STORAGE_PREFIX,
  SUBTITLE_DRAFT_VERSION,
  clearSubtitleDraft,
  decidePendingEditResyncAction,
  hasUnsavedSubtitleChanges,
  parseStoredSubtitleDraft,
  readSubtitleDraft,
  rekeySubtitleDraft,
  safeSubtitleDraftStorage,
  subtitleDraftEquals,
  subtitleDraftKey,
  writeSubtitleDraft,
  type StorageLike,
  type SubtitleDraftState,
} from "../src/app/(dashboard)/video-editor/_v2/subtitle-draft-storage";
import { DEFAULT_V2_SUB, type V2SubConfig } from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";

function makeState(overrides: Partial<SubtitleDraftState> = {}): SubtitleDraftState {
  return {
    captions: [
      { text: "ประโยคเปิดคลิป", startMs: 0, endMs: 1_400, tag: "hook" },
      { text: "เนื้อหาหลักของคลิป", startMs: 1_400, endMs: 3_100, tag: "body" },
      { text: "กดติดตามได้เลย", startMs: 3_100, endMs: 4_500, tag: "cta" },
    ],
    overrides: {
      0: { textColor: "#FFE500" },
    },
    cfg: { ...DEFAULT_V2_SUB },
    cardLen: "sentence",
    tailHoldMs: 0,
    ...overrides,
  };
}

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let checks = 0;
function pass(label: string) {
  checks += 1;
  console.log(`  PASS  ${label}`);
}

console.log("1) Dirty detection across captions, overrides, cfg, cardLen, tailHoldMs");
{
  const baseline = makeState();
  assert.equal(hasUnsavedSubtitleChanges(makeState(), baseline), false);
  pass("identical baseline state is clean");

  assert.equal(
    hasUnsavedSubtitleChanges(
      makeState({
        captions: [
          { text: "ประโยคเปิดที่แก้แล้ว", startMs: 0, endMs: 1_400, tag: "hook" },
          baseline.captions[1],
          baseline.captions[2],
        ],
      }),
      baseline,
    ),
    true,
  );
  pass("caption text change marks dirty");

  assert.equal(
    hasUnsavedSubtitleChanges(
      makeState({
        captions: [
          { ...baseline.captions[0], endMs: 1_650 },
          baseline.captions[1],
          baseline.captions[2],
        ],
      }),
      baseline,
    ),
    true,
  );
  pass("caption timing change marks dirty");

  assert.equal(
    hasUnsavedSubtitleChanges(
      makeState({
        captions: [...baseline.captions, { text: "การ์ดใหม่", startMs: 4_500, endMs: 5_200, tag: "body" }],
      }),
      baseline,
    ),
    true,
  );
  pass("inserted caption card marks dirty");

  assert.equal(
    hasUnsavedSubtitleChanges(
      makeState({ overrides: { 0: { textColor: "#38BDF8" } } }),
      baseline,
    ),
    true,
  );
  pass("per-card override change marks dirty");

  assert.equal(
    hasUnsavedSubtitleChanges(
      makeState({ cfg: { ...baseline.cfg, fontSize: 96 } }),
      baseline,
    ),
    true,
  );
  assert.equal(
    hasUnsavedSubtitleChanges(
      makeState({ cfg: { ...baseline.cfg, preset: "hormozi", effect: "bounce" } }),
      baseline,
    ),
    true,
  );
  assert.equal(
    hasUnsavedSubtitleChanges(
      makeState({ cfg: { ...baseline.cfg, fontWeight: 600, bold: false } }),
      baseline,
    ),
    true,
  );
  assert.equal(
    hasUnsavedSubtitleChanges(
      makeState({ cfg: { ...baseline.cfg, sfxMode: "subtle" } }),
      baseline,
    ),
    true,
  );
  pass("subtitle cfg changes (fontSize, preset/effect, fontWeight, sfxMode) mark dirty");

  assert.equal(hasUnsavedSubtitleChanges(makeState({ cardLen: "3" }), baseline), true);
  pass("cardLen change marks dirty");

  assert.equal(hasUnsavedSubtitleChanges(makeState({ tailHoldMs: 1_200 }), baseline), true);
  pass("tailHoldMs change marks dirty");

  // Benign normalizations never cause false dirty positives
  const legacyBaseline = makeState({
    cfg: {
      ...DEFAULT_V2_SUB,
      fontWeight: undefined,
      bold: true,
      highlightKeywords: undefined,
      statCards: undefined,
      sfxMode: undefined,
    },
    overrides: { 0: { textColor: "#FFE500" }, 1: {} },
  });
  const normalizedCurrent = makeState({
    cfg: {
      ...DEFAULT_V2_SUB,
      fontWeight: 900,
      bold: true,
      highlightKeywords: false,
      statCards: false,
      sfxMode: "none",
    },
    overrides: { 0: { textColor: "#FFE500" } },
  });
  assert.equal(subtitleDraftEquals(normalizedCurrent, legacyBaseline), true);
  pass("benign normalizations (fontWeight/bold fallback, undefined vs false/none, empty override) stay clean");

  // Defensive against synthetic partial configs (e.g. test fixtures with `{}`)
  const partial = {
    captions: [],
    overrides: {},
    cfg: {} as V2SubConfig,
    cardLen: "sentence" as const,
    tailHoldMs: 0,
  };
  assert.equal(subtitleDraftEquals(partial, { ...partial }), true);
  pass("partial synthetic configs compare safely without throwing");
}

console.log("2) Per-job localStorage save, load, scope isolation, validation, and clear");
{
  const storage = new MemoryStorage();
  const scopeA = { accountId: "acct-1", projectId: "proj-1", jobId: "job-1" };
  const scopeB = { accountId: "acct-1", projectId: "proj-1", jobId: "job-2" };
  const scopeOtherAcct = { accountId: "acct-2", projectId: "proj-1", jobId: "job-1" };

  assert.equal(subtitleDraftKey({ accountId: null, projectId: "proj-1", jobId: "job-1" }), null);
  assert.equal(subtitleDraftKey({ accountId: "acct-1", projectId: "", jobId: "job-1" }), null);
  assert.equal(subtitleDraftKey({ accountId: "acct-1", projectId: "proj-1", jobId: "  " }), null);
  assert.equal(writeSubtitleDraft(storage, { accountId: null, projectId: "proj-1", jobId: "job-1" }, makeState()), false);
  pass("missing accountId/projectId/jobId fails closed without writing");

  const edited = makeState({
    captions: [
      { text: "ซับที่แก้ไขแล้ว", startMs: 0, endMs: 1_500, tag: "hook" },
      { text: "การ์ดสอง", startMs: 1_500, endMs: 3_000, tag: "cta" },
    ],
    overrides: { 1: { accentColor: "#34D399" } },
    cfg: { ...DEFAULT_V2_SUB, fontSize: 92, verticalPos: 74, highlightKeywords: true },
    cardLen: "2",
    tailHoldMs: 1_500,
  });

  assert.equal(writeSubtitleDraft(storage, scopeA, edited, 1_732_000_000_000), true);
  const loaded = readSubtitleDraft(storage, scopeA);
  assert.ok(loaded, "stored draft reads back");
  assert.equal(loaded.version, SUBTITLE_DRAFT_VERSION);
  assert.equal(loaded.jobId, "job-1");
  assert.equal(loaded.savedAt, 1_732_000_000_000);
  assert.equal(subtitleDraftEquals(loaded, edited), true);
  assert.equal(readSubtitleDraft(storage, scopeB), null, "different jobId is isolated");
  assert.equal(readSubtitleDraft(storage, scopeOtherAcct), null, "different accountId is isolated");
  pass("save/load round-trips all 5 fields + savedAt + jobId and isolates account/project/job");

  // Validation fails closed on corruption/tampering
  const keyA = subtitleDraftKey(scopeA)!;
  const validRaw = storage.getItem(keyA)!;
  storage.setItem(keyA, "{not-json");
  assert.equal(readSubtitleDraft(storage, scopeA), null);
  assert.equal(parseStoredSubtitleDraft({ ...JSON.parse(validRaw), version: 2 }, "job-1"), null);
  assert.equal(parseStoredSubtitleDraft({ ...JSON.parse(validRaw), jobId: "wrong-job" }, "job-1"), null);
  assert.equal(parseStoredSubtitleDraft({ ...JSON.parse(validRaw), cardLen: "99" }, "job-1"), null);
  assert.equal(
    parseStoredSubtitleDraft({ ...JSON.parse(validRaw), overrides: { 9: { textColor: "#fff" } } }, "job-1"),
    null,
  );
  assert.equal(
    parseStoredSubtitleDraft(
      { ...JSON.parse(validRaw), captions: [{ text: "bad", startMs: 2_000, endMs: 1_000 }] },
      "job-1",
    ),
    null,
  );
  storage.setItem(keyA, validRaw);
  pass("corrupt JSON and malformed schemas fail closed");

  assert.equal(writeSubtitleDraft(storage, scopeB, makeState(), 1_732_000_001_000), true);
  assert.equal(clearSubtitleDraft(storage, scopeA), true);
  assert.equal(readSubtitleDraft(storage, scopeA), null);
  assert.ok(readSubtitleDraft(storage, scopeB), "clearing one job keeps sibling jobs intact");
  pass("clear removes only the target job draft");
}

console.log("3) Re-key / migration on adoptJob (B-roll apply + reload survival)");
{
  const storage = new MemoryStorage();
  const owner = { accountId: "acct-1", projectId: "proj-1" };
  const edited = makeState({
    captions: [{ text: "แก้ก่อนกด B-roll", startMs: 0, endMs: 1_500, tag: "hook" }],
    overrides: { 0: { textColor: "#38BDF8" } },
    tailHoldMs: 800,
  });
  assert.equal(writeSubtitleDraft(storage, { ...owner, jobId: "source-job" }, edited, 1_732_000_100_000), true);

  const migrated = rekeySubtitleDraft(storage, owner, "source-job", "adopted-job");
  assert.ok(migrated);
  assert.equal(migrated.jobId, "adopted-job");
  assert.equal(migrated.savedAt, 1_732_000_100_000);
  assert.equal(subtitleDraftEquals(migrated, edited), true);
  assert.equal(readSubtitleDraft(storage, { ...owner, jobId: "source-job" }), null, "old key removed after migration");
  assert.ok(readSubtitleDraft(storage, { ...owner, jobId: "adopted-job" }), "new key readable after reload");
  pass("rekeySubtitleDraft migrates draft to adopted jobId and clears old key");

  // Newer destination draft wins over older source draft
  const newerEdited = makeState({
    captions: [{ text: "ใหม่กว่า", startMs: 0, endMs: 1_500, tag: "hook" }],
  });
  assert.equal(writeSubtitleDraft(storage, { ...owner, jobId: "source-job" }, edited, 1_000), true);
  assert.equal(writeSubtitleDraft(storage, { ...owner, jobId: "adopted-job" }, newerEdited, 2_000), true);
  const kept = rekeySubtitleDraft(storage, owner, "source-job", "adopted-job");
  assert.ok(kept);
  assert.equal(kept.captions[0].text, "ใหม่กว่า");
  assert.equal(readSubtitleDraft(storage, { ...owner, jobId: "source-job" }), null);
  pass("rekeySubtitleDraft keeps a newer destination draft and cleans up stale source");

  // Failed write on destination preserves source draft (no data loss under quota failure)
  const failDestStorage = new MemoryStorage();
  assert.equal(writeSubtitleDraft(failDestStorage, { ...owner, jobId: "src-quota" }, edited, 1_000), true);
  const destKey = subtitleDraftKey({ ...owner, jobId: "dst-quota" })!;
  const origSetItem = failDestStorage.setItem.bind(failDestStorage);
  failDestStorage.setItem = (k: string, v: string) => {
    if (k === destKey) throw new DOMException("Quota exceeded", "QuotaExceededError");
    origSetItem(k, v);
  };
  assert.equal(rekeySubtitleDraft(failDestStorage, owner, "src-quota", "dst-quota"), null);
  assert.ok(
    readSubtitleDraft(failDestStorage, { ...owner, jobId: "src-quota" }),
    "source draft remains intact if destination write fails",
  );
  pass("rekeySubtitleDraft preserves source draft when destination write hits quota");
}

console.log("4) SecurityError (private browsing) and QuotaExceededError safety");
{
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          throw new DOMException("Access is denied for this document.", "SecurityError");
        },
      },
    });
    assert.equal(safeSubtitleDraftStorage(), null);
    assert.equal(readSubtitleDraft(safeSubtitleDraftStorage(), { accountId: "a", projectId: "p", jobId: "j" }), null);
    assert.equal(
      writeSubtitleDraft(safeSubtitleDraftStorage(), { accountId: "a", projectId: "p", jobId: "j" }, makeState()),
      false,
    );
    assert.equal(clearSubtitleDraft(safeSubtitleDraftStorage(), { accountId: "a", projectId: "p", jobId: "j" }), false);
    pass("window.localStorage getter SecurityError fails silently without throwing");
  } finally {
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }

  const securityThrowStorage: StorageLike = {
    getItem() { throw new DOMException("Access denied", "SecurityError"); },
    setItem() { throw new DOMException("Access denied", "SecurityError"); },
    removeItem() { throw new DOMException("Access denied", "SecurityError"); },
  };
  assert.equal(readSubtitleDraft(securityThrowStorage, { accountId: "a", projectId: "p", jobId: "j" }), null);
  assert.equal(writeSubtitleDraft(securityThrowStorage, { accountId: "a", projectId: "p", jobId: "j" }, makeState()), false);
  assert.equal(clearSubtitleDraft(securityThrowStorage, { accountId: "a", projectId: "p", jobId: "j" }), false);
  pass("getItem/setItem/removeItem SecurityError never throws");

  // QuotaExceededError evicts corrupt/oldest subtitle drafts first (never unrelated app keys) and retries
  const quotaStorage = new MemoryStorage();
  const unrelatedKey = "editor-v2-broll-apply:acct-1:proj-1";
  quotaStorage.setItem(unrelatedKey, '{"version":1}');
  const oldestScope = { accountId: "acct-1", projectId: "proj-1", jobId: "oldest-job" };
  const newerSiblingScope = { accountId: "acct-1", projectId: "proj-1", jobId: "newer-sibling-job" };
  const corruptKey = `${SUBTITLE_DRAFT_STORAGE_PREFIX}acct-1:proj-1:corrupt-job`;
  assert.equal(writeSubtitleDraft(quotaStorage, oldestScope, makeState(), 1_000), true);
  assert.equal(writeSubtitleDraft(quotaStorage, newerSiblingScope, makeState(), 5_000), true);
  quotaStorage.setItem(corruptKey, "{broken");

  // Initial write + first retry fail -> evicts corrupt first, then oldest, while sparing newer sibling
  let quotaFailuresRemaining = 2;
  const baseSetItem = quotaStorage.setItem.bind(quotaStorage);
  quotaStorage.setItem = (k: string, v: string) => {
    if (quotaFailuresRemaining > 0) {
      quotaFailuresRemaining -= 1;
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    }
    baseSetItem(k, v);
  };
  const freshScope = { accountId: "acct-1", projectId: "proj-1", jobId: "fresh-job" };
  assert.equal(writeSubtitleDraft(quotaStorage, freshScope, makeState({ tailHoldMs: 500 }), 6_000), true);
  assert.equal(quotaStorage.getItem(corruptKey), null, "corrupt subtitle draft was evicted first");
  assert.equal(readSubtitleDraft(quotaStorage, oldestScope), null, "oldest subtitle draft was evicted next");
  assert.ok(readSubtitleDraft(quotaStorage, newerSiblingScope), "newer sibling draft was spared once space freed");
  assert.equal(quotaStorage.getItem(unrelatedKey), '{"version":1}', "unrelated B-roll journal key was untouched");
  assert.equal(readSubtitleDraft(quotaStorage, freshScope)?.tailHoldMs, 500);
  pass("QuotaExceededError evicts corrupt then oldest subtitle drafts incrementally, spares newer & unrelated keys, and retries");

  // Persistent QuotaExceededError returns false without throwing
  const alwaysFullStorage: StorageLike = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => { throw new DOMException("Full", "QuotaExceededError"); },
    removeItem: () => {},
  };
  assert.equal(writeSubtitleDraft(alwaysFullStorage, freshScope, makeState(), 3_000), false);
  pass("persistent QuotaExceededError returns false without throwing");

  // Oversized draft (> SUBTITLE_DRAFT_MAX_BYTES) fails safely
  const giantCaptions = Array.from({ length: 120 }, (_, i) => ({
    text: "ก".repeat(1_000),
    startMs: i * 1_000,
    endMs: (i + 1) * 1_000,
    tag: "body",
  }));
  const giantSerialized = JSON.stringify(giantCaptions);
  assert.ok(Buffer.byteLength(giantSerialized, "utf8") > SUBTITLE_DRAFT_MAX_BYTES);
  const oversizeStorage = new MemoryStorage();
  assert.equal(writeSubtitleDraft(oversizeStorage, freshScope, makeState({ captions: giantCaptions }), 4_000), false);
  assert.equal(oversizeStorage.map.size, 0);
  pass("oversized draft payload is rejected before calling setItem");
}

console.log("5) Pending-edit rebase race guard (decidePendingEditResyncAction)");
{
  assert.equal(
    decidePendingEditResyncAction({
      incomingRevision: 3,
      appliedRevision: null,
      hasUnsavedLocalSubtitles: false,
      brollRebaseInFlight: false,
      forceApply: false,
    }),
    "apply-draft",
  );
  pass("clean editor adopts initial async pendingEdit normally");

  assert.equal(
    decidePendingEditResyncAction({
      incomingRevision: 3,
      appliedRevision: 3,
      hasUnsavedLocalSubtitles: true,
      brollRebaseInFlight: false,
      forceApply: false,
    }),
    "refresh-media-only",
  );
  pass("equal revision only refreshes untouched media pointers");

  assert.equal(
    decidePendingEditResyncAction({
      incomingRevision: 4,
      appliedRevision: 3,
      hasUnsavedLocalSubtitles: true,
      brollRebaseInFlight: true,
      forceApply: false,
    }),
    "preserve-local-subtitles-rebase",
  );
  assert.equal(
    decidePendingEditResyncAction({
      incomingRevision: 4,
      appliedRevision: 3,
      hasUnsavedLocalSubtitles: false,
      brollRebaseInFlight: true,
      forceApply: false,
    }),
    "preserve-local-subtitles-rebase",
  );
  pass("B-roll rebase revision bump never overwrites local subtitle edits");

  assert.equal(
    decidePendingEditResyncAction({
      incomingRevision: 5,
      appliedRevision: 3,
      hasUnsavedLocalSubtitles: true,
      brollRebaseInFlight: false,
      forceApply: false,
    }),
    "preserve-local-subtitles",
  );
  pass("unsolicited revision bump while local subtitle edits are unsaved preserves local subtitles");

  assert.equal(
    decidePendingEditResyncAction({
      incomingRevision: 5,
      appliedRevision: 3,
      hasUnsavedLocalSubtitles: true,
      brollRebaseInFlight: false,
      forceApply: true,
    }),
    "apply-forced",
  );
  pass("explicit 409 stale_revision reload forces adoption of the agent's latest draft");
}

console.log("6) Editor hook, desktop/mobile banner, and 'แก้ซับต่อ' wiring invariants");
{
  const root = process.cwd();
  const hookSource = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts"),
    "utf8",
  );
  const desktopSource = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx"),
    "utf8",
  );
  const mobileSource = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx"),
    "utf8",
  );
  const bannerSource = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/SubtitleDraftRestoreBanner.tsx"),
    "utf8",
  );
  const shellSource = readFileSync(
    path.join(root, "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx"),
    "utf8",
  );

  // 1) beforeunload covers both pending B-roll and unsaved subtitle edits + flushes on unload/pagehide
  assert.match(
    hookSource,
    /const hasUnsavedChanges = pendingBrollEditCount > 0 \|\| hasUnsavedSubtitleEdits;/,
    "beforeunload guard combines pending B-roll edits and unsaved subtitle edits",
  );
  assert.match(
    hookSource,
    /window\.addEventListener\("beforeunload", warnAboutUnsavedChanges\)/,
    "beforeunload listener registered",
  );
  assert.match(
    hookSource,
    /window\.addEventListener\("pagehide", persistOnPageHide\)/,
    "pagehide listener flushes draft for mobile tab drops",
  );
  pass("beforeunload + pagehide guard covers unsaved subtitle edits");

  // 2) Debounced save, B-roll apply flush & adoptJob re-key, export clear
  assert.match(hookSource, /SUBTITLE_DRAFT_DEBOUNCE_MS/, "debounced localStorage write configured");
  assert.match(hookSource, /flushSubtitleDraftNow\(operation\.sourceJobId\)/, "flushes subtitle draft before B-roll apply");
  assert.match(hookSource, /rekeySubtitleDraft\(/, "re-keys subtitle draft on B-roll job adoption");
  assert.match(
    hookSource,
    /clearStoredSubtitleDraft\(\[exportSource\.jobId, job\.jobId, activeDraftJobIdRef\.current\]\)/,
    "clears stored draft upon successful export",
  );
  pass("debounced save, B-roll adoptJob re-key, and export clear are wired");

  // 3) Pending-edit rebase guard & 409 forced reload
  assert.match(hookSource, /decidePendingEditResyncAction\(/, "pendingEdit resync effect uses rebase race guard");
  assert.match(hookSource, /brollRebasePendingRef\.current = true;/, "marks B-roll rebase before adoptJob");
  assert.match(
    hookSource,
    /if \(result\.staleRevision\)[\s\S]{0,400}?forceApplyNextPendingEditRef\.current = true;/,
    "409 stale_revision arms forced agent draft reload",
  );
  pass("pendingEdit rebase race guard and 409 forced reload are wired");

  // 4) Restore & discard handlers restore/clear all 5 fields
  assert.match(
    hookSource,
    /function restoreSubtitleDraft\(\)[\s\S]*?setCaptions\(nextCaptions\)[\s\S]*?setOverrides\(nextOverrides\)[\s\S]*?setCfg\(nextCfg\)[\s\S]*?setCardLen\(draft\.cardLen\)[\s\S]*?setTailHoldMsState\(nextTailHoldMs\)/,
    "restoreSubtitleDraft restores captions, overrides, cfg, cardLen, and tailHoldMs",
  );
  assert.match(
    hookSource,
    /function discardSubtitleDraft\(\)[\s\S]*?clearStoredSubtitleDraft\(/,
    "discardSubtitleDraft clears stored draft and dirty state",
  );
  pass("restoreSubtitleDraft & discardSubtitleDraft cover all 5 subtitle fields");

  // 5) Desktop & mobile surfaces render SubtitleDraftRestoreBanner + Thai copy + "แก้ซับต่อ" continuity
  assert.equal(SUBTITLE_DRAFT_RESTORE_COPY.title, "พบการแก้ไขซับที่ยังไม่ได้ส่งออก");
  assert.equal(SUBTITLE_DRAFT_RESTORE_COPY.restoreLabel, "กู้คืนการแก้ไข");
  assert.equal(SUBTITLE_DRAFT_RESTORE_COPY.discardLabel, "ทิ้งฉบับร่าง");
  assert.match(bannerSource, /data-subtitle-draft-restore-banner="true"/);
  assert.match(bannerSource, /data-subtitle-draft-action="restore"/);
  assert.match(bannerSource, /data-subtitle-draft-action="discard"/);
  assert.match(
    desktopSource,
    /<SubtitleDraftRestoreBanner[\s\S]{0,200}?draft=\{ed\.restorableSubtitleDraft\}[\s\S]{0,200}?onRestore=\{ed\.restoreSubtitleDraft\}[\s\S]{0,200}?onDiscard=\{ed\.discardSubtitleDraft\}/,
    "PostPhase.tsx wires SubtitleDraftRestoreBanner",
  );
  assert.match(
    mobileSource,
    /<SubtitleDraftRestoreBanner[\s\S]{0,200}?draft=\{ed\.restorableSubtitleDraft\}[\s\S]{0,200}?onRestore=\{ed\.restoreSubtitleDraft\}[\s\S]{0,200}?onDiscard=\{ed\.discardSubtitleDraft\}/,
    "PostPhaseMobile.tsx wires SubtitleDraftRestoreBanner",
  );
  assert.match(
    shellSource,
    /job\.output\?\.editSnapshot[\s\S]{0,80}?resumeExportEditSnapshot/,
    "EditorV2Shell.tsx routes 'แก้ซับต่อ' through resumeExportEditSnapshot into PostPhase",
  );
  pass("desktop PostPhase, mobile PostPhaseMobile, and 'แก้ซับต่อ' wiring verified");
}

console.log(`\nsubtitle-draft-recovery: all ${checks} checks passed`);
