// Daily: mine new Thai loanwords from the last ~26h of prod scripts, auto-apply
// them via SiteConfig, notify admins. Reversible via the store's denylist.
//   DATABASE_URL=... npx tsx scripts/cron-mine-loanwords.ts
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/prisma";
import { THAI_LOANWORDS } from "../src/lib/thai-loanwords";
import { mineLoanwords, loadThaiDict } from "../src/lib/loanword-mining";
import { readLoanwordStore, writeLoanwordStore, mergeStore } from "../src/lib/thai-loanwords-runtime";
import { notifyAdmins } from "../src/lib/notifications";

const LOOKBACK_MS = 26 * 60 * 60 * 1000;
const CAP = 25;

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
  const found = mineLoanwords(scripts, dict, already, { minLen: 4, cap: CAP });
  const newWords = found.map((f) => f.word);

  const next = mergeStore({ ...store, lastRunAt: new Date().toISOString(), lastAdded: newWords }, newWords);
  await writeLoanwordStore(next);

  console.log(`[mine-loanwords] scripts=${scripts.length} added=${newWords.length} ${newWords.join(",")}`);
  await prisma.telemetryEvent.create({ data: { name: "loanwords.mined", category: "pipeline", source: "server", value: newWords.length, properties: JSON.stringify({ added: newWords, scripts: scripts.length }) } });
  if (newWords.length > 0) {
    await notifyAdmins({
      type: "ERROR_SYSTEM",
      title: `เพิ่มคำตัดซับใหม่ ${newWords.length} คำ`,
      body: `ระบบเจอ loanword ที่ตัดผิดจากงานวันนี้และเพิ่มเข้าระบบแล้ว: ${newWords.join(", ")} — ถ้าคำไหนไม่ถูก เพิ่มลง denylist ใน SiteConfig["thaiLoanwordsAuto"]`,
    });
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("[mine-loanwords] failed:", e); process.exit(1); });
