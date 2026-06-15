// Mine Thai loanwords that Intl.Segmenter mis-splits, from REAL prod scripts —
// so src/lib/thai-loanwords.ts grows from actual multi-business usage, not guesses.
//
// Method: dictionary maximal-matching (PyThaiNLP wordlist) as an oracle vs ICU.
// A dict word whose ICU segmentation contains a non-dictionary "gibberish"
// fragment is a loanword ICU broke — exactly the bug. Native compounds (ไม่|ต้อง)
// split into real words and are skipped.
//
// Inputs (produce these first):
//   1) Thai wordlist:
//      curl -sL -o /tmp/words_th.txt \
//        https://raw.githubusercontent.com/PyThaiNLP/pythainlp/dev/pythainlp/corpus/words_th.txt
//   2) Prod scripts as JSON-quoted lines (one per line, newlines escaped). On the VPS:
//      sqlite3 -readonly $DB "SELECT json_quote(json_extract(inputJson,'$.script'))
//        FROM VideoJob WHERE createdAt>=<ms> AND json_extract(inputJson,'$.script') IS NOT NULL;" > /tmp/today_scripts.jsonl
//      sqlite3 -readonly $DB "SELECT json_quote(script) FROM Video
//        WHERE createdAt>=<ms> AND script IS NOT NULL AND length(script)>0;" >> /tmp/today_scripts.jsonl
// Run:
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/mine-thai-loanwords.ts
// Then eyeball the output and add the real loanwords to src/lib/thai-loanwords.ts.
import * as fs from "fs";
import { THAI_LOANWORDS } from "../src/lib/thai-loanwords";

const WORDLIST = process.env.WORDLIST_PATH || "/tmp/words_th.txt";
const SCRIPTS = process.env.SCRIPTS_PATH || "/tmp/today_scripts.jsonl";

const dict = new Set<string>();
let maxLen = 2;
for (const raw of fs.readFileSync(WORDLIST, "utf8").split("\n")) {
  const w = raw.trim();
  if (/^[ก-๙]{2,24}$/.test(w)) { dict.add(w); if (w.length > maxLen) maxLen = w.length; }
}
const scripts: string[] = [];
for (const line of fs.readFileSync(SCRIPTS, "utf8").split("\n")) {
  const t = line.trim(); if (!t) continue;
  try { const s = JSON.parse(t); if (typeof s === "string" && s.trim()) scripts.push(s); } catch { /* skip */ }
}
const seg = new Intl.Segmenter("th", { granularity: "word" });
const already = new Set(THAI_LOANWORDS);
const COMMON = new Set(["ที่","ไม่","ได้","ใน","ของ","จะ","และ","การ","ความ","มี","ให้","เป็น","กับ","ก็","ว่า","แต่","นี้","นั้น","ครับ","ค่ะ","ต้อง","มา","ไป","อยาก","ตัว","เอง","วัน","ตอน","คน"]);
const freq = new Map<string, number>();

function dictWords(span: string, base: number) {
  const out: { word: string; s: number; e: number }[] = [];
  let i = 0;
  while (i < span.length) {
    let matched = "";
    for (let L = Math.min(maxLen, span.length - i); L >= 2; L--) { const c = span.substr(i, L); if (dict.has(c)) { matched = c; break; } }
    if (matched) { out.push({ word: matched, s: base + i, e: base + i + matched.length }); i += matched.length; } else i += 1;
  }
  return out;
}
const icuFrags = (w: string) => [...seg.segment(w)].map((t) => t.segment);

for (const script of scripts) {
  const icu = new Set<number>();
  for (const tok of seg.segment(script)) icu.add(tok.index);
  const seen = new Set<string>();
  const re = /[ก-๙]{2,}/g; let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    for (const dw of dictWords(m[0], m.index)) {
      if (dw.word.length < 4 || already.has(dw.word)) continue;
      let cut = false; for (let b = dw.s + 1; b < dw.e; b++) if (icu.has(b)) { cut = true; break; }
      if (!cut) continue;
      const gibberish = icuFrags(dw.word).some((f) => !dict.has(f) && !COMMON.has(f));
      if (!gibberish) continue; // native compound split into real words → fine
      if (!seen.has(dw.word)) { seen.add(dw.word); freq.set(dw.word, (freq.get(dw.word) ?? 0) + 1); }
    }
  }
}
const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);
console.log(`scripts=${scripts.length} dict=${dict.size}  new loanword-like mis-splits: ${ranked.length}\n`);
for (const [w, n] of ranked) console.log(`${String(n).padStart(2)}x  ${w.padEnd(16)} => ${icuFrags(w).join("|")}`);
