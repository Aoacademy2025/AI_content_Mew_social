import type { VersionPlan } from "@/lib/desktop/types";

export type DistinctnessLabel = VersionPlan["distinctness"];

export function talkingSet(sequence: string[]): Set<string> {
  return new Set(sequence.filter((id) => typeof id === "string" && id.length > 0));
}

export function setKey(ids: Iterable<string>): string {
  return [...new Set(ids)].sort().join("\0");
}

export function setsEqual(a: Iterable<string>, b: Iterable<string>): boolean {
  return setKey(a) === setKey(b);
}

/** r(V,W) = |set(V) ∩ set(W)| / max(|set(V)|, |set(W)|). Empty sets → 0. */
export function sharedRatio(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const B = new Set(b);
  const denom = Math.max(A.size, B.size);
  if (denom === 0) return 0;
  let inter = 0;
  for (const id of A) if (B.has(id)) inter++;
  return inter / denom;
}

export function worstSharedRatio(target: Iterable<string>, others: Iterable<string>[]): number {
  if (others.length === 0) return 0;
  let worst = 0;
  for (const other of others) worst = Math.max(worst, sharedRatio(target, other));
  return worst;
}

/** สูง r ≤ 0.40, กลาง 0.40 < r ≤ 0.70, ต่ำ r > 0.70 */
export function distinctnessFromWorstR(worstR: number): DistinctnessLabel {
  if (worstR <= 0.40) return "สูง";
  if (worstR <= 0.70) return "กลาง";
  return "ต่ำ";
}

export function normalizeDistinctText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/#\S+/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFE0E\uFE0F\u200D]/g, "")
    .replace(/\p{P}/gu, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function textsDistinct(a: string, b: string): boolean {
  return normalizeDistinctText(a) !== normalizeDistinctText(b);
}

export function versionsHaveEqualSets(versions: { sequence: string[] }[]): boolean {
  const seen = new Set<string>();
  for (const v of versions) {
    const key = setKey(talkingSet(v.sequence));
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function versionsHaveDuplicateCopy(versions: { headline: string; caption: string }[]): boolean {
  const headlines = new Set<string>();
  const captions = new Set<string>();
  for (const v of versions) {
    const h = normalizeDistinctText(v.headline);
    const c = normalizeDistinctText(v.caption);
    if (headlines.has(h) || captions.has(c)) return true;
    headlines.add(h);
    captions.add(c);
  }
  return false;
}

export function regenerateCollides(
  candidate: { sequence: string[]; headline: string; caption: string },
  existing: { sequence: string[]; headline: string; caption: string }[],
): boolean {
  const candSet = talkingSet(candidate.sequence);
  for (const other of existing) {
    if (setsEqual(candSet, talkingSet(other.sequence))) return true;
    if (!textsDistinct(candidate.headline, other.headline)) return true;
    if (!textsDistinct(candidate.caption, other.caption)) return true;
  }
  return false;
}

export function capForTalkingCount(k: number): number {
  if (k <= 0) return 0;
  if (k === 1) return 1;
  if (k === 2) return 1;
  if (k === 3) return 4;
  if (k === 4) return 8;
  return 12;
}

function combinations(ids: string[], size: number): string[][] {
  const out: string[][] = [];
  const acc: string[] = [];
  const rec = (start: number) => {
    if (acc.length === size) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < ids.length; i++) {
      acc.push(ids[i]);
      rec(i + 1);
      acc.pop();
    }
  };
  rec(0);
  return out;
}

/**
 * Admissible family: subsets with all pairwise r ≤ 0.70.
 * k=1 → the singleton; k=2 → the one pair; k≥3 → all size-2 and size-3
 * subsets (pairwise r ≤ 2/3). Matches rule 4 family sizes (k=3→4, k=4→10).
 */
export function enumerateAdmissibleSubsets(talkingIds: string[]): string[][] {
  const ids = [...new Set(talkingIds)];
  if (ids.length === 0) return [];
  if (ids.length === 1) return [[ids[0]]];
  if (ids.length === 2) return [ids];
  return [...combinations(ids, 2), ...combinations(ids, 3)];
}

export function maxVersionsForTalkingCount(k: number): number {
  if (k <= 0) return 0;
  const ids = Array.from({ length: k }, (_, i) => `t${i}`);
  return Math.min(capForTalkingCount(k), enumerateAdmissibleSubsets(ids).length);
}

export function clampRequestedVersions(n: number, k: number): {
  n: number;
  maxVersions: number;
  clampedReason?: string;
} {
  const maxVersions = maxVersionsForTalkingCount(k);
  const raw = Number.isFinite(n) ? Math.floor(n) : 1;
  const wanted = raw < 1 ? 1 : raw;
  if (wanted <= maxVersions) return { n: wanted, maxVersions };
  const clampedReason = k <= 2
    ? `มีฟุตพูด ${k} คลิป จึงสร้างได้แค่ 1 เวอร์ชันที่ไม่ซ้ำชุด — ถ่ายฟุตพูดเพิ่มหรือใช้โหมดแตกคลิป`
    : `ขอได้สูงสุด ${maxVersions} เวอร์ชันสำหรับฟุตพูด ${k} คลิป ตามกฎความต่างของชุดฟุตพูด`;
  return { n: maxVersions, maxVersions, clampedReason };
}

export function assignDistinctness<T extends { sequence: string[] }>(
  versions: T[],
): Array<T & { distinctness: DistinctnessLabel }> {
  return versions.map((v, i) => {
    const others = versions.filter((_, j) => j !== i).map((o) => talkingSet(o.sequence));
    return { ...v, distinctness: distinctnessFromWorstR(worstSharedRatio(talkingSet(v.sequence), others)) };
  });
}

export function pickUnusedSubset(family: string[][], existing: { sequence: string[] }[]): string[] | null {
  const used = new Set(existing.map((v) => setKey(talkingSet(v.sequence))));
  return family.find((s) => !used.has(setKey(s))) ?? null;
}

export function uniqueThaiOrdinal(n: number): string {
  return ["หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า", "สิบ", "สิบเอ็ด", "สิบสอง"][n] ?? String(n + 1);
}
