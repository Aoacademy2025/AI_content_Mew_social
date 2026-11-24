// Daily: mine new Thai loanwords & native compounds from the last ~26h of prod scripts,
// auto-apply safe entries via SiteConfig, and notify admins. Reversible via denylist.
//   Pass 1 — dictionary-oracle loanwords (dict words ICU mis-splits). Always runs.
//   Pass 2 — LLM loanwords (dict-independent recall, the ~72% Pass 1 can't reach). Runs only
//            when a server Gemini key is set; auto-applies only guard-passing words.
//   Pass 3 — native compounds (dict words ICU splits into all-real fragments) →
//            Deterministic Safety Guard + Gemini AI Reviewer:
//              - safe + genuine fixed compound → auto-approved into `compounds` (undoable)
//              - unsafe / non-compound noise   → auto-rejected into `denylist`
//              - genuinely borderline          → kept in `pendingCompounds` for human check
//   DATABASE_URL=... npx tsx scripts/cron-mine-loanwords.ts
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/prisma";
import { THAI_LOANWORDS } from "../src/lib/thai-loanwords";
import { THAI_COMPOUNDS } from "../src/lib/thai-compounds";
import { mineLoanwords, mineCompoundCandidates, loadThaiDict } from "../src/lib/loanword-mining";
import {
  readLoanwordStore,
  writeLoanwordStore,
  mergeStore,
  applyCompoundReview,
} from "../src/lib/thai-loanwords-runtime";
import { mineWithLlm } from "../src/lib/loanword-llm-miner";
import {
  buildDictStraddleIndex,
  COMPOUND_REVIEW_JSON_SCHEMA,
  reviewCompoundsWithLlm,
} from "../src/lib/compound-review";
import { getServerGeminiKey } from "../src/lib/server-keys";
import { geminiGenerateText } from "../src/lib/gemini";
import { notifyAdmins } from "../src/lib/notifications";

const LOOKBACK_MS = 26 * 60 * 60 * 1000;
const CAP = 25;
const LLM_CAP = 15;
const COMPOUND_CAP = 25;

async function main() {
  const since = new Date(Date.now() - LOOKBACK_MS);
  const jobs = await prisma.videoJob.findMany({ where: { createdAt: { gte: since } }, select: { inputJson: true } });
  const vids = await prisma.video.findMany({ where: { createdAt: { gte: since }, script: { not: null } }, select: { script: true } });
  const scripts: string[] = [];
  for (const j of jobs) { try { const s = JSON.parse(j.inputJson)?.script; if (typeof s === "string" && s.trim()) scripts.push(s); } catch { /* skip */ } }
  for (const v of vids) { if (typeof v.script === "string" && v.script.trim()) scripts.push(v.script); }

  const dict = loadThaiDict(fs.readFileSync(path.join(process.cwd(), "data/words_th.txt"), "utf8"));
  const store = await readLoanwordStore();
  const already = new Set([...THAI_LOANWORDS, ...store.words, ...store.denylist]);
  // Pass 1 — dictionary-oracle
  const found = mineLoanwords(scripts, dict, already, { minLen: 4, cap: CAP });
  const dictWords = found.map((f) => f.word);

  // Pass 2 — LLM (only with a server key). `covered` includes Pass-1 hits so the
  // two passes don't propose duplicates. mineWithLlm enforces the 4 guards.
  let llmWords: string[] = [];
  const serverKey = await getServerGeminiKey();
  if (serverKey) {
    const covered = new Set([...already, ...dictWords]);
    const proposed = await mineWithLlm(scripts, covered, dict, (p) => geminiGenerateText(serverKey, p, 2048, 0));
    llmWords = proposed.slice(0, LLM_CAP);
  } else {
    console.log("[mine-loanwords] no server Gemini key — skipping LLM pass (Pass 1 only)");
  }

  const newWords = [...dictWords, ...llmWords];
  let next = mergeStore({ ...store, lastRunAt: new Date().toISOString(), lastAdded: newWords }, newWords);

  // Pass 3 — native-compound candidates + deterministic safety guard + AI auto-review.
  const alreadyCompounds = new Set<string>([
    ...THAI_LOANWORDS, ...THAI_COMPOUNDS,
    ...next.words, ...(next.compounds ?? []), ...next.denylist, ...(next.pendingCompounds ?? []),
  ]);
  const rawCompoundCands = mineCompoundCandidates(scripts, dict, alreadyCompounds, { minLen: 4, cap: COMPOUND_CAP }).map((c) => c.word);

  const straddleIndex = buildDictStraddleIndex(dict);
  const reviewedCompounds = rawCompoundCands.length > 0
    ? await reviewCompoundsWithLlm(rawCompoundCands, {
        straddleIndex,
        batchSize: 35,
        callLlm: serverKey
          ? (p) => geminiGenerateText(serverKey, p, 2048, 0, {
              responseMimeType: "application/json",
              responseJsonSchema: COMPOUND_REVIEW_JSON_SCHEMA,
            })
          : null,
      })
    : [];

  next = {
    ...next,
    lastCompoundRunAt: new Date().toISOString(),
    lastCompoundsFound: rawCompoundCands,
  };
  let compoundSummary = { approved: 0, rejected: 0, keptForReview: 0, source: "cron" as const };
  if (reviewedCompounds.length > 0) {
    const applied = applyCompoundReview(next, reviewedCompounds, { source: "cron" });
    next = applied.store;
    compoundSummary = applied.summary;
  }

  await writeLoanwordStore(next);

  const autoApproved = reviewedCompounds.filter((r) => r.decision === "approve").map((r) => r.word);
  const keptReview = reviewedCompounds.filter((r) => r.decision === "review").map((r) => r.word);
  const autoRejected = reviewedCompounds.filter((r) => r.decision === "reject").map((r) => r.word);

  console.log(
    `[mine-loanwords] scripts=${scripts.length} dict=${dictWords.length} llm=${llmWords.length} added=[${newWords.join(",")}] ` +
    `compounds: raw=${rawCompoundCands.length} approved=[${autoApproved.join(",")}] rejected=${autoRejected.length} review=[${keptReview.join(",")}]`,
  );
  await prisma.telemetryEvent.create({
    data: {
      name: "loanwords.mined",
      category: "pipeline",
      source: "server",
      value: newWords.length,
      properties: JSON.stringify({ dict: dictWords, llm: llmWords, scripts: scripts.length }),
    },
  });
  await prisma.telemetryEvent.create({
    data: {
      name: "compounds.mined",
      category: "pipeline",
      source: "server",
      value: rawCompoundCands.length,
      properties: JSON.stringify({
        candidates: rawCompoundCands,
        approved: autoApproved,
        rejectedCount: autoRejected.length,
        review: keptReview,
        scripts: scripts.length,
      }),
    },
  });
  if (newWords.length > 0) {
    await notifyAdmins({
      type: "ERROR_SYSTEM",
      title: `เพิ่มคำตัดซับใหม่ ${newWords.length} คำ`,
      body: `ระบบเจอ loanword ที่ตัดผิดจากงานวันนี้และเพิ่มเข้าระบบแล้ว — dict: ${dictWords.join(", ") || "—"} · LLM: ${llmWords.join(", ") || "—"} — จัดการ/ถอนได้ที่ /admin/loanwords`,
    });
  }
  if (autoApproved.length > 0 || keptReview.length > 0) {
    const parts: string[] = [];
    if (autoApproved.length > 0) parts.push(`AI อนุมัติอัตโนมัติ ${autoApproved.length} คำ (${autoApproved.join(", ")})`);
    if (autoRejected.length > 0) parts.push(`ตัดคำเสี่ยง/ไม่ใช่คำประสมออก ${autoRejected.length} คำ`);
    if (keptReview.length > 0) parts.push(`เหลือก้ำกึ่งรอตรวจ ${keptReview.length} คำ (${keptReview.join(", ")})`);
    await notifyAdmins({
      type: "ERROR_SYSTEM",
      title: keptReview.length > 0
        ? `คำประสม: AI อนุมัติ ${autoApproved.length} · รอตรวจ ${keptReview.length} คำ`
        : `AI อนุมัติคำประสมใหม่ ${autoApproved.length} คำ`,
      body: `${parts.join(" · ")} — ตรวจสอบหรือถอนย้อนหลังได้ที่ /admin/loanwords`,
    });
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("[mine-loanwords] failed:", e); process.exit(1); });
