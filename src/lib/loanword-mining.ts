// Pure dictionary-oracle miner: find Thai loanwords that Intl.Segmenter mis-splits.
// A dict word whose ICU segmentation contains a non-dictionary "gibberish" fragment
// is a loanword ICU broke (native compounds split into real words → skipped). No I/O.
export interface MineResult { word: string; count: number; frags: string[] }
export interface MineOpts { minLen?: number; cap?: number }

const COMMON = new Set(["ที่","ไม่","ได้","ใน","ของ","จะ","และ","การ","ความ","มี","ให้","เป็น","กับ","ก็","ว่า","แต่","นี้","นั้น","ครับ","ค่ะ","ต้อง","มา","ไป","อยาก","ตัว","เอง","วัน","ตอน","คน"]);

function maxLenOf(dict: Set<string>): number { let m = 2; for (const w of dict) if (w.length > m) m = w.length; return m; }

function dictWords(span: string, base: number, dict: Set<string>, maxLen: number) {
  const out: { word: string; s: number; e: number }[] = [];
  let i = 0;
  while (i < span.length) {
    let matched = "";
    for (let L = Math.min(maxLen, span.length - i); L >= 2; L--) { const c = span.substr(i, L); if (dict.has(c)) { matched = c; break; } }
    if (matched) { out.push({ word: matched, s: base + i, e: base + i + matched.length }); i += matched.length; } else i += 1;
  }
  return out;
}

export function mineLoanwords(scripts: string[], dict: Set<string>, already: Set<string>, opts: MineOpts = {}): MineResult[] {
  const minLen = opts.minLen ?? 4;
  const cap = opts.cap ?? 25;
  const maxLen = maxLenOf(dict);
  const seg = new Intl.Segmenter("th", { granularity: "word" });
  const icuFrags = (w: string) => [...seg.segment(w)].map((t) => t.segment);
  const freq = new Map<string, number>();
  for (const script of scripts) {
    if (typeof script !== "string" || !script) continue;
    const icu = new Set<number>();
    for (const tok of seg.segment(script)) icu.add(tok.index);
    const seen = new Set<string>();
    const re = /[ก-๙]{2,}/g; let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) {
      for (const dw of dictWords(m[0], m.index, dict, maxLen)) {
        if (dw.word.length < minLen || already.has(dw.word)) continue;
        let cut = false; for (let b = dw.s + 1; b < dw.e; b++) if (icu.has(b)) { cut = true; break; }
        if (!cut) continue;
        const gibberish = icuFrags(dw.word).some((f) => !dict.has(f) && !COMMON.has(f));
        if (!gibberish) continue;
        if (!seen.has(dw.word)) { seen.add(dw.word); freq.set(dw.word, (freq.get(dw.word) ?? 0) + 1); }
      }
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([word, count]) => ({ word, count, frags: icuFrags(word) }));
}

export function loadThaiDict(text: string): Set<string> {
  const dict = new Set<string>();
  for (const raw of text.split("\n")) { const w = raw.trim(); if (/^[ก-๙]{2,24}$/.test(w)) dict.add(w); }
  return dict;
}
