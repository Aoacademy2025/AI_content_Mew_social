/**
 * Script cleaning before TTS — moved out of page.tsx (P1-style extraction) so the
 * legacy editor and Editor v2 share ONE cleaner.
 *
 * 2026-07-03 hardening (Mew's v2 review): also strip {braces}, misc symbol/dingbat
 * ranges the old emoji range missed, and cap punctuation runs that make TTS อ่านเพี้ยน
 * (....... → "..." · !!! → ! · ??? → ?). "..." (3 จุด) is kept ON PURPOSE — the
 * subtitle-timing layer uses ellipsis as a pause weight (PR #74) and TTS reads it
 * as a natural pause.
 */

/** Clean one line (no newline handling) — used by v2 counters that keep segment structure. */
export function cleanScriptLine(line: string): string {
  return line
    // ตัดวงเล็บและเนื้อหาข้างใน — ไม่ควรอ่านออกเสียง เช่น (Artificial Intelligence), (อ่านว่า xxx)
    .replace(/\([^)]{1,80}\)/g, "")
    // ตัดวงเล็บเหลี่ยม/ปีกกาและเนื้อหาข้างใน เช่น [หมายเหตุ], {โน้ต}
    .replace(/\[[^\]]{1,80}\]/g, "")
    .replace(/\{[^}]{1,80}\}/g, "")
    // ตัด hashtag เช่น #AI #tech
    .replace(/#\S+/g, "")
    // ตัด URL
    .replace(/https?:\/\/\S+/g, "")
    // ตัด emoji + สัญลักษณ์พิเศษ (dingbats, arrows, misc symbols)
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "")
    // ตัด stage direction เช่น *หยุดพัก*, _เน้น_
    .replace(/\*[^*]{1,50}\*/g, "")
    .replace(/_[^_]{1,50}_/g, "")
    // ยุบ punctuation ซ้ำที่ทำ TTS เพี้ยน (คง "..." ไว้เป็น pause)
    .replace(/\.{4,}/g, "...")
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    .replace(/\s{2,}/g, " ");
}

/** Full-script cleaner sent to TTS/transcribe — collapses newlines like the original. */
export function preprocessScript(raw: string): string {
  return cleanScriptLine(raw.replace(/\r?\n/g, " ")).trim();
}
