import assert from "node:assert/strict";
import fs from "node:fs";

import { searchWindowCandidatesWithDegrade } from "../src/lib/broll-window-search";

const inspector = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx",
  "utf8",
);
const editor = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts",
  "utf8",
);
const desktop = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/PostPhase.tsx",
  "utf8",
);
const mobile = fs.readFileSync(
  "src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx",
  "utf8",
);
const jobsRoute = fs.readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
const orchestrator = fs.readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
const composition = fs.readFileSync("src/remotion/ShortVideoComposition.tsx", "utf8");
const compositeRoute = fs.readFileSync("src/app/api/heygen/composite/route.ts", "utf8");

assert.match(inspector, /แสดง B-roll ช่วงนี้/u);
assert.match(inspector, /สลับกับฉากก่อนหน้า/u);
assert.match(inspector, /สลับกับฉากถัดไป/u);
assert.match(inspector, /คลิป Avatar ต้นฉบับ/u);
assert.match(editor, /undoWindowEdits/u);
assert.match(editor, /redoWindowEdits/u);
assert.match(editor, /enabled:\s*e\.enabled/u);
assert.doesNotMatch(desktop, /avatarModel !== "upload-cutaway"/u);
assert.doesNotMatch(mobile, /avatarModel !== "upload-cutaway"/u);
assert.doesNotMatch(jobsRoute, /cutaway_not_supported/u);
assert.match(orchestrator, /mode:\s*"cutaway"/u);
assert.match(composition, /brollEnabled/u);
assert.match(mobile, /minHeight:\s*44/u);

// H1/H2/H3 — the cutaway re-render never guesses and never fails open.
assert.match(orchestrator, /reconstructCutawayPersonRanges/u);
assert.match(orchestrator, /planCutawayRecomposite/u);
assert.match(orchestrator, /rrDecision\.skipComposite/u);
assert.doesNotMatch(orchestrator, /resolveCutawayPersonRanges/u); // baseline is explicit, never inferred
// mode:"cutaway" with no valid personRange must be rejected before any ffmpeg work.
assert.match(compositeRoute, /mode === "cutaway" && !buildEnableExpr\(personRanges\)/u);
assert.doesNotMatch(compositeRoute, /no ranges => behave like full \(fail-open\)/u);

// M3 — a disabled window can never spend credits on an AI image.
assert.match(inspector, /ปิด B-roll ช่วงนี้อยู่/u);
assert.match(inspector, /disabled=\{aiBusy \|\|[^\n]*!enabled/u);
assert.match(inspector, /เปิด B-roll ช่วงนี้ก่อน/u);

// P1 — uploaded/staged B-roll must never be silently dropped by Export or "Render new".
const exportStart = editor.indexOf("async function exportVideo(");
const exportEnd = editor.indexOf("\n  return {", exportStart);
assert.ok(exportStart >= 0 && exportEnd > exportStart, "exportVideo source is missing");
const exportSource = editor.slice(exportStart, exportEnd);
assert.match(exportSource, /resolveBrollExportSource/u);
assert.match(exportSource, /pendingEditCount:\s*windowEdits\.size/u);
assert.doesNotMatch(exportSource, /sourceJobId:\s*job\.jobId/u);
assert.match(editor, /pendingBrollIntent/u);
assert.match(editor, /requestNewProject/u);
assert.match(editor, /applyPendingBrollAndContinue/u);
assert.match(editor, /discardPendingBrollAndContinue/u);
assert.match(desktop, /PendingBrollChangesDialog/u);
assert.match(mobile, /PendingBrollChangesDialog/u);
assert.doesNotMatch(desktop, /onClick=\{onNewProject\}/u);
assert.doesNotMatch(mobile, /onClick=\{onNewProject\}/u);
assert.match(inspector, /อัปเดต B-roll แล้วส่งออก/u);

// Support regression 2026-08-30 — after an applied B-roll preview becomes the
// project's active source, the public Export route must reject every older source.
const durableExportStart = jobsRoute.indexOf('if (body.mode === "export")');
const durableExportEnd = jobsRoute.indexOf("\n    const projectId =", durableExportStart);
assert.ok(durableExportStart >= 0 && durableExportEnd > durableExportStart, "durable Export route source is missing");
const durableExportRoute = jobsRoute.slice(durableExportStart, durableExportEnd);
const sourceGuardIndex = durableExportRoute.indexOf("assertCurrentEditorExportSource(");
const durableCreateIndex = durableExportRoute.indexOf("createVideoJob(");
assert.ok(sourceGuardIndex >= 0, "durable Export must assert the project's current preview source");
assert.ok(
  durableCreateIndex > sourceGuardIndex,
  "durable Export must reject a stale source before creating a VideoJob",
);
assert.match(jobsRoute, /error:\s*"stale_export_source"/u);

// Support regression #odqpq2 — toggling a baked B-roll window stages a free
// re-render; the current video preview cannot change until the batch is applied.
// The UI must say that explicitly both in the inspector and the sticky action bar.
assert.match(inspector, /ตัวอย่างยังเป็นวิดีโอเดิม/u);
assert.match(inspector, /กด “อัปเดตวิดีโอ” ด้านล่าง/u);

// Support regression cms4jnk0o02mhlcpiz462hd65 — a "new project" confirmation
// must never promise only a re-render when both successful actions actually call
// onNewProject(). That mismatch made a successful free B-roll apply look like the
// editor closed and the charged render disappeared.
const pendingDialogStart = inspector.indexOf("export function PendingBrollChangesDialog");
const pendingDialogEnd = inspector.indexOf("\nexport function BrollWindowInspector", pendingDialogStart);
assert.ok(pendingDialogStart >= 0 && pendingDialogEnd > pendingDialogStart, "pending B-roll dialog source is missing");
const pendingDialog = inspector.slice(pendingDialogStart, pendingDialogEnd);
assert.match(pendingDialog, /กำลังจะสร้างโปรเจกต์ใหม่/u);
assert.match(pendingDialog, /งานเดิมยังอยู่ในรายการโปรเจกต์/u);
assert.match(pendingDialog, /ฟรีและไม่ใช้นาทีเพิ่ม/u);
assert.match(pendingDialog, /ทิ้ง B-roll แล้วสร้างโปรเจกต์ใหม่/u);
assert.match(pendingDialog, /อัปเดต B-roll แล้วสร้างโปรเจกต์ใหม่/u);
assert.doesNotMatch(pendingDialog, /แล้วเรนเดอร์ใหม่/u);
assert.match(editor, /editor_pending_broll_dialog_opened/u);
assert.match(editor, /editor_pending_broll_action_selected/u);

// ── Per-window search degrade (Task 4 / F7, round-1 review fix) ─────────────
// The "เปลี่ยนรูป" search runs the keyword qualified by the project's Step-2
// preferences and widens back to the plain keyword when that finds nothing.
// A zero caused by EVERY provider failing (outage, revoked or rate-limited key)
// is not a genuine zero: widening there only doubles the failing calls and hides
// the real cause from the creator. These count the actual searches performed.
const windowSearchRoute = fs.readFileSync("src/app/api/videos/broll-window/search/route.ts", "utf8");
assert.match(windowSearchRoute, /searchWindowCandidatesWithDegrade<Candidate>/u);
// asked/answered: only a provider we hold a key for can succeed or fail.
assert.match(windowSearchRoute, /allProvidersFailed: asked > 0 && answered === 0/u);
// the outage-blind version of the rule must not come back
assert.doesNotMatch(windowSearchRoute, /candidates\.length === 0 && styledKeyword !== keyword/u);
assert.match(windowSearchRoute, /brollRegionPreference: normalizeBrollRegionPreference/u);

type StubOutcome = { candidates: string[]; allProvidersFailed: boolean };
function stubSearch(outcomes: Record<string, StubOutcome>) {
  const calls: string[] = [];
  const degraded: string[] = [];
  return {
    calls,
    degraded,
    search: async (query: string) => {
      calls.push(query);
      return outcomes[query] ?? { candidates: [], allProvidersFailed: false };
    },
    onDegrade: (query: string) => degraded.push(query),
  };
}

async function verifyWindowSearchDegrade() {
  const styled = "thai office workers cinematic";
  const plain = "office workers";

  // (a) every provider failed → the plain-keyword search must NOT fire
  const outage = stubSearch({ [styled]: { candidates: [], allProvidersFailed: true } });
  assert.deepEqual(
    await searchWindowCandidatesWithDegrade({ styledQuery: styled, plainKeyword: plain, search: outage.search, onDegrade: outage.onDegrade }),
    [],
  );
  assert.deepEqual(outage.calls, [styled], "a provider outage must never trigger the plain-keyword search");
  assert.deepEqual(outage.degraded, [], "an outage is not a degrade");

  // (b) genuine zero → exactly one widening search with the creator's keyword
  const genuineZero = stubSearch({
    [styled]: { candidates: [], allProvidersFailed: false },
    [plain]: { candidates: ["clip-1"], allProvidersFailed: false },
  });
  assert.deepEqual(
    await searchWindowCandidatesWithDegrade({ styledQuery: styled, plainKeyword: plain, search: genuineZero.search, onDegrade: genuineZero.onDegrade }),
    ["clip-1"],
  );
  assert.deepEqual(genuineZero.calls, [styled, plain], "a genuine zero widens exactly once");
  assert.deepEqual(genuineZero.degraded, [styled]);

  // (c) the qualified query found footage → one search only
  const hit = stubSearch({ [styled]: { candidates: ["clip-1"], allProvidersFailed: false } });
  assert.deepEqual(
    await searchWindowCandidatesWithDegrade({ styledQuery: styled, plainKeyword: plain, search: hit.search }),
    ["clip-1"],
  );
  assert.deepEqual(hit.calls, [styled], "a successful styled query never searches twice");

  // (d) no preference applied (styled === plain) → never a second search
  const unqualified = stubSearch({ [plain]: { candidates: [], allProvidersFailed: false } });
  assert.deepEqual(
    await searchWindowCandidatesWithDegrade({ styledQuery: plain, plainKeyword: plain, search: unqualified.search }),
    [],
  );
  assert.deepEqual(unqualified.calls, [plain], "an unqualified query is never searched twice");

  // (e) the widening search failing returns an empty list — never a third call
  const widenFails = stubSearch({
    [styled]: { candidates: [], allProvidersFailed: false },
    [plain]: { candidates: [], allProvidersFailed: true },
  });
  assert.deepEqual(
    await searchWindowCandidatesWithDegrade({ styledQuery: styled, plainKeyword: plain, search: widenFails.search }),
    [],
  );
  assert.deepEqual(widenFails.calls, [styled, plain], "the degrade never retries a third time");
}

verifyWindowSearchDegrade()
  .then(() => {
    console.log("B-roll window management UI/render contract passed");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
