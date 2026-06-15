// Mine Thai loanwords ICU mis-splits from REAL prod scripts (standalone/manual run).
// Pure logic lives in src/lib/loanword-mining.ts (shared with the daily cron).
//
// Inputs (produce these first):
//   1) Thai wordlist (committed at data/words_th.txt, or override WORDLIST_PATH):
//      curl -sL -o /tmp/words_th.txt \
//        https://raw.githubusercontent.com/PyThaiNLP/pythainlp/dev/pythainlp/corpus/words_th.txt
//   2) Prod scripts as JSON-quoted lines (one per line). On the VPS:
//      sqlite3 -readonly $DB "SELECT json_quote(json_extract(inputJson,'$.script'))
//        FROM VideoJob WHERE createdAt>=<ms> AND json_extract(inputJson,'$.script') IS NOT NULL;" > /tmp/today_scripts.jsonl
//      sqlite3 -readonly $DB "SELECT json_quote(script) FROM Video
//        WHERE createdAt>=<ms> AND script IS NOT NULL AND length(script)>0;" >> /tmp/today_scripts.jsonl
// Run:
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/mine-thai-loanwords.ts
// Then add the real loanwords to src/lib/thai-loanwords.ts (or let the cron auto-apply).
import * as fs from "fs";
import { THAI_LOANWORDS } from "../src/lib/thai-loanwords";
import { mineLoanwords, loadThaiDict } from "../src/lib/loanword-mining";

const dict = loadThaiDict(fs.readFileSync(process.env.WORDLIST_PATH || "/tmp/words_th.txt", "utf8"));
const scripts: string[] = [];
for (const line of fs.readFileSync(process.env.SCRIPTS_PATH || "/tmp/today_scripts.jsonl", "utf8").split("\n")) {
  const t = line.trim(); if (!t) continue;
  try { const s = JSON.parse(t); if (typeof s === "string" && s.trim()) scripts.push(s); } catch { /* skip */ }
}
const res = mineLoanwords(scripts, dict, new Set(THAI_LOANWORDS), { minLen: 4, cap: 9999 });
console.log(`scripts=${scripts.length} dict=${dict.size}  new loanword-like mis-splits: ${res.length}\n`);
for (const r of res) console.log(`${String(r.count).padStart(2)}x  ${r.word.padEnd(16)} => ${r.frags.join("|")}`);
