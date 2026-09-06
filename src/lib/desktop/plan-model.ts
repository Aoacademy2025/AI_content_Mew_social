import { geminiGenerateText } from "@/lib/gemini";
import { resolveGeminiKey } from "@/lib/gemini-key";
import { recordAiTextCall } from "@/lib/ai-text-limits";
import type { Overlay, PlanVersionsRequest, TalkingInput, TranscriptSegment, VersionPlan } from "@/lib/desktop/types";
import {
  assignDistinctness,
  clampRequestedVersions,
  enumerateAdmissibleSubsets,
  pickUnusedSubset,
  regenerateCollides,
  setKey,
  talkingSet,
  textsDistinct,
  uniqueThaiOrdinal,
  versionsHaveDuplicateCopy,
  versionsHaveEqualSets,
} from "@/lib/desktop/distinctness";
import { passesThaiOutput } from "@/lib/desktop/thai-output";
import {
  parsePlanSplitJson,
  parsePlanVersionsJson,
  proposeSplitSpans,
  type ModelSplitDraft,
  type ModelVersionDraft,
} from "@/lib/desktop/plan-json";

export type DesktopPlanTextGenerator = (
  prompt: string,
  opts: { maxOutputTokens: number; temperature: number },
) => Promise<string>;

let testGenerator: DesktopPlanTextGenerator | null = null;

export function setDesktopPlanTextGeneratorForTests(fn: DesktopPlanTextGenerator | null): void {
  if (process.env.DESKTOP_PLAN_VERIFY !== "1") return;
  testGenerator = fn;
}

const VERSION_JSON_SCHEMA = {
  type: "object",
  required: ["versions"],
  properties: {
    versions: {
      type: "array",
      items: {
        type: "object",
        required: ["sequence", "overlays", "headline", "caption", "rationale"],
        properties: {
          sequence: { type: "array", items: { type: "string" } },
          overlays: {
            type: "array",
            items: {
              type: "object",
              required: ["productFootageId", "anchor", "lenSec"],
              properties: {
                productFootageId: { type: "string" },
                anchor: {
                  type: "object",
                  required: ["talkingFootageId", "segmentIndex"],
                  properties: {
                    talkingFootageId: { type: "string" },
                    segmentIndex: { type: "integer" },
                  },
                },
                lenSec: { type: "number" },
              },
            },
          },
          headline: { type: "string" },
          caption: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
  },
};

const SPLIT_JSON_SCHEMA = {
  type: "object",
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        required: ["start", "end", "headline", "caption", "reason"],
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          headline: { type: "string" },
          caption: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
};

export type PlanQuotaError = { kind: "quota"; remaining: number; message: string };
export type PlanModelError = { kind: "invalid" } | { kind: "provider"; detail: string } | PlanQuotaError;

async function generateDesktopPlanText(
  user: { geminiKey: string | null; plan: string },
  prompt: string,
  schema: unknown,
  maxOutputTokens = 4096,
  temperature = 0.55,
): Promise<string> {
  if (testGenerator) return testGenerator(prompt, { maxOutputTokens, temperature });
  const { key } = resolveGeminiKey(user);
  return geminiGenerateText(key, prompt, maxOutputTokens, temperature, {
    responseMimeType: "application/json",
    responseJsonSchema: schema,
  });
}

async function callWithJsonRetry<T>(
  userId: string,
  user: { geminiKey: string | null; plan: string },
  prompt: string,
  parse: (raw: string) => T | null,
  schema: unknown,
): Promise<{ ok: true; value: T } | { ok: false; error: PlanModelError }> {
  const reserved = await recordAiTextCall(userId);
  if (!reserved.allowed) {
    return {
      ok: false,
      error: {
        kind: "quota",
        remaining: reserved.remaining,
        message: reserved.message ?? "ใช้ AI ช่วยประมวลผลข้อความครบเพดานรอบนี้แล้ว — รอรอบถัดไป",
      },
    };
  }

  let raw: string;
  try {
    raw = await generateDesktopPlanText(user, prompt, schema);
  } catch (error) {
    return { ok: false, error: { kind: "provider", detail: error instanceof Error ? error.message : String(error) } };
  }

  const first = parse(raw);
  if (first) return { ok: true, value: first };

  const retryReserve = await recordAiTextCall(userId);
  if (!retryReserve.allowed) {
    return {
      ok: false,
      error: {
        kind: "quota",
        remaining: retryReserve.remaining,
        message: retryReserve.message ?? "ใช้ AI ช่วยประมวลผลข้อความครบเพดานรอบนี้แล้ว — รอรอบถัดไป",
      },
    };
  }

  const repair = `${prompt}\n\nคำตอบก่อนหน้าไม่ใช่ JSON ตามสคีมา — ตอบ JSON ที่ถูกต้องเท่านั้น ไม่มี markdown:\n${raw.slice(0, 1500)}`;
  try {
    raw = await generateDesktopPlanText(user, repair, schema);
  } catch (error) {
    return { ok: false, error: { kind: "provider", detail: error instanceof Error ? error.message : String(error) } };
  }
  const second = parse(raw);
  if (second) return { ok: true, value: second };
  return { ok: false, error: { kind: "invalid" } };
}

function talkingById(talking: TalkingInput[]): Map<string, TalkingInput> {
  return new Map(talking.map((t) => [t.footageId, t]));
}

function sanitizeOverlays(
  overlays: Overlay[],
  sequence: string[],
  talkingMap: Map<string, TalkingInput>,
  productIds: Set<string>,
): Overlay[] {
  const seen = new Set<string>();
  const out: Overlay[] = [];
  for (const overlay of overlays) {
    if (!productIds.has(overlay.productFootageId)) continue;
    if (!sequence.includes(overlay.anchor.talkingFootageId)) continue;
    const footage = talkingMap.get(overlay.anchor.talkingFootageId);
    if (!footage) continue;
    const idx = overlay.anchor.segmentIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx >= footage.transcript.length) continue;
    if (overlay.anchor.talkingFootageId === sequence[0] && idx === 0) continue;
    const key = `${overlay.anchor.talkingFootageId}:${idx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lenSec = Math.min(3, Math.max(1.5, overlay.lenSec));
    out.push({
      productFootageId: overlay.productFootageId,
      anchor: { talkingFootageId: overlay.anchor.talkingFootageId, segmentIndex: idx },
      lenSec,
    });
  }
  return out;
}

function snapSequence(sequence: string[], family: string[][], used: Set<string>): string[] {
  const key = setKey(talkingSet(sequence));
  const match = family.find((s) => setKey(s) === key);
  if (match && !used.has(key)) {
    const allowed = new Set(match);
    const ordered = sequence.filter((id) => allowed.has(id));
    for (const id of match) if (!ordered.includes(id)) ordered.push(id);
    return ordered;
  }
  const unused = family.find((s) => !used.has(setKey(s)));
  return unused ? [...unused] : (match ? [...match] : sequence);
}

function fallbackCopy(
  index: number,
  productName: string,
  usedHeadlines: string[],
  usedCaptions: string[],
): { headline: string; caption: string } {
  for (let i = 0; i < 20; i++) {
    const ord = uniqueThaiOrdinal(index + i);
    const headline = `มุม${ord}ที่คนดูยังไม่เห็น`;
    const caption = `สรุปเหตุผลมุม${ord}ของ${productName} จากฟุตพูดชุดนี้`;
    if (
      usedHeadlines.every((h) => textsDistinct(headline, h)) &&
      usedCaptions.every((c) => textsDistinct(caption, c))
    ) {
      return { headline, caption };
    }
  }
  return {
    headline: `มุมใหม่ที่ ${index + 1} ของสินค้า`,
    caption: `รายละเอียดมุมที่ ${index + 1} จากฟุตพูดที่ไม่ซ้ำชุด`,
  };
}

function transcriptDigest(talking: TalkingInput[]): string {
  return talking.map((t) => {
    const lines = t.transcript.map((s, i) => `  [${i}] ${s.start.toFixed(1)}-${s.end.toFixed(1)} ${s.text}`).join("\n");
    return `Talking Footage ${t.footageId} (${t.durationSec}s)\n${lines}`;
  }).join("\n\n");
}

function headlineRules(): string {
  return `คุณคือบรรณาธิการพาดหัววิดีโอสั้นภาษาไทยสำหรับ Facebook Reels, TikTok และ Shorts

กฎพาดหัว (Hook Headline) — ใช้แพทเทิร์นเดียวกับระบบเขียนพาดหัวของ Hero AI:
- ใช้ข้อเท็จจริงจาก TRANSCRIPT เท่านั้น ห้ามแต่งตัวเลข ชื่อ เหตุการณ์ หรือข้อสรุปใหม่
- headline กระชับ ชัด ไม่เกินประมาณ 64 ตัวอักษร และแสดงได้ไม่เกิน 2 บรรทัด
- ไม่ใช้ markdown, hashtag, emoji หรือคำเกริ่นก่อน JSON
- รักษาภาษาหลักและน้ำเสียงของ TRANSCRIPT
- Caption เป็นข้อความโพสต์ภาษาไทย (มีแฮชแท็กท้ายได้) คนละมุมกับเวอร์ชันอื่น
- หลังตัดแฮชแท็ก URL อีโมจิ และชื่อสินค้า หัวข้อและแคปชันต้องเป็นภาษาไทยอย่างน้อย 60%`;
}

function versionsPrompt(req: PlanVersionsRequest, family: string[][], n: number, unusedOnly?: string[][]): string {
  const pool = unusedOnly ?? family;
  const subsets = pool.map((s) => s.join("+")).join(", ");
  const products = req.productFootage.map((p) => `${p.footageId} (${p.durationSec}s)`).join(", ") || "(ไม่มี)";
  const existing = req.existing?.map((v) =>
    `set={${[...talkingSet(v.sequence)].sort().join(",")}} headline=${v.headline} caption=${v.caption}`
  ).join("\n") ?? "(ไม่มี)";
  return `${headlineRules()}

สินค้า: ${req.product.name}
คำอธิบาย: ${req.product.description}
พาดหัวที่เคยเซฟ: ${req.product.savedHeadlines.join(" / ") || "(ไม่มี)"}
สไตล์: ${req.style}

ชุดฟุตพูดที่เลือกได้เท่านั้น (เลือกจากนี้): ${subsets}
ต้องเลือก ${n} ชุด ที่บอกมุมขายต่างกัน แล้วเรียงลำดับ sequence เป็น footageId
วาง Overlay สินค้า: anchor เป็นเซ็กเมนต์ของ Talking Footage ใน sequence, lenSec 1.5–3.0, ไม่เกิน 1 ต่อเซ็กเมนต์, ห้ามเซ็กเมนต์แรกของเวอร์ชัน

ห้ามชุดที่ซ้ำกับของที่มีอยู่:
${existing}

TRANSCRIPT:
${transcriptDigest(req.talking)}

Product Footage: ${products}

ตอบ JSON เท่านั้น:
{"versions":[{"sequence":["id",...],"overlays":[{"productFootageId":"...","anchor":{"talkingFootageId":"...","segmentIndex":1},"lenSec":2}],"headline":"...","caption":"...","rationale":"..."}]}`;
}

function itemViolates(
  item: ModelVersionDraft,
  siblings: ModelVersionDraft[],
  productName: string,
  existing: { sequence: string[]; headline: string; caption: string }[] = [],
): boolean {
  if (!passesThaiOutput(item.headline, productName) || !passesThaiOutput(item.caption, productName)) return true;
  if (regenerateCollides(item, existing)) return true;
  const others = siblings.filter((s) => s !== item);
  if (versionsHaveEqualSets([item, ...others])) return true;
  if (versionsHaveDuplicateCopy([item, ...others])) return true;
  return false;
}

function finalizeVersions(
  drafts: ModelVersionDraft[],
  talking: TalkingInput[],
  productIds: Set<string>,
  startIndex = 0,
): VersionPlan[] {
  const talkingMap = talkingById(talking);
  const cleaned = drafts.map((d) => ({
    ...d,
    overlays: sanitizeOverlays(d.overlays, d.sequence, talkingMap, productIds),
  }));
  return assignDistinctness(cleaned).map((v, i) => ({
    index: startIndex + i,
    sequence: v.sequence,
    overlays: v.overlays,
    headline: v.headline,
    caption: v.caption,
    distinctness: v.distinctness,
    rationale: v.rationale || "มุมขายจากชุดฟุตพูดนี้",
  }));
}

function repairDrafts(
  drafts: ModelVersionDraft[],
  family: string[][],
  productName: string,
  existing: { sequence: string[]; headline: string; caption: string }[] = [],
): ModelVersionDraft[] {
  const used = new Set(existing.map((v) => setKey(talkingSet(v.sequence))));
  const out: ModelVersionDraft[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const snapped = snapSequence(drafts[i].sequence, family, used);
    used.add(setKey(talkingSet(snapped)));
    out.push({ ...drafts[i], sequence: snapped });
  }
  const headlines = existing.map((e) => e.headline);
  const captions = existing.map((e) => e.caption);
  for (let i = 0; i < out.length; i++) {
    const others = [...existing, ...out.filter((_, j) => j !== i)];
    if (
      !passesThaiOutput(out[i].headline, productName) ||
      !passesThaiOutput(out[i].caption, productName) ||
      regenerateCollides(out[i], others)
    ) {
      const copy = fallbackCopy(i, productName, [...headlines, ...out.map((d) => d.headline)], [...captions, ...out.map((d) => d.caption)]);
      out[i] = { ...out[i], ...copy };
    }
    headlines.push(out[i].headline);
    captions.push(out[i].caption);
  }
  return out;
}

export async function planCombineVersions(
  userId: string,
  user: { geminiKey: string | null; plan: string },
  req: PlanVersionsRequest,
): Promise<
  | { ok: true; maxVersions: number; clampedReason?: string; versions: VersionPlan[] }
  | { ok: false; error: PlanModelError | { kind: "no_set" } }
> {
  const ids = req.talking.map((t) => t.footageId);
  const family = enumerateAdmissibleSubsets(ids);
  const productIds = new Set(req.productFootage.map((p) => p.footageId));
  const productName = req.product.name;
  const regen = req.regenerateIndex != null && Array.isArray(req.existing);

  if (regen) {
    const existing = req.existing ?? [];
    const unused = pickUnusedSubset(family, existing);
    if (!unused) return { ok: false, error: { kind: "no_set" } };
    const unusedFamily = family.filter((s) => !existing.some((e) => setKey(talkingSet(e.sequence)) === setKey(s)));
    let drafts: ModelVersionDraft[] = [];
    const first = await callWithJsonRetry(userId, user, versionsPrompt(req, family, 1, unusedFamily), parsePlanVersionsJson, VERSION_JSON_SCHEMA);
    if (!first.ok) return first;
    drafts = first.value.versions.slice(0, 1);
    drafts = repairDrafts(drafts, unusedFamily.length ? unusedFamily : family, productName, existing);

    for (let pass = 0; pass < 2 && drafts.some((d) => itemViolates(d, drafts, productName, existing)); pass++) {
      const again = await callWithJsonRetry(
        userId,
        user,
        versionsPrompt(req, family, 1, unusedFamily) + "\nเวอร์ชันก่อนหน้าซ้ำชุดหรือข้อความกับของเดิม — เลือกชุดที่ยังไม่ใช้และเขียนหัวข้อ/แคปชันใหม่",
        parsePlanVersionsJson,
        VERSION_JSON_SCHEMA,
      );
      if (!again.ok) break;
      drafts = repairDrafts(again.value.versions.slice(0, 1), unusedFamily.length ? unusedFamily : family, productName, existing);
    }
    drafts = repairDrafts(drafts, unusedFamily.length ? unusedFamily : family, productName, existing);
    const versions = finalizeVersions(drafts, req.talking, productIds, req.regenerateIndex ?? 0);
    return { ok: true, maxVersions: clampRequestedVersions(1, ids.length).maxVersions, versions };
  }

  const clamped = clampRequestedVersions(req.n, ids.length);
  const first = await callWithJsonRetry(userId, user, versionsPrompt(req, family, clamped.n), parsePlanVersionsJson, VERSION_JSON_SCHEMA);
  if (!first.ok) return first;
  let drafts = repairDrafts(first.value.versions.slice(0, clamped.n), family, productName);
  while (drafts.length < clamped.n) {
    const next = pickUnusedSubset(family, drafts);
    if (!next) break;
    const copy = fallbackCopy(drafts.length, productName, drafts.map((d) => d.headline), drafts.map((d) => d.caption));
    drafts.push({ sequence: next, overlays: [], rationale: "เติมชุดที่ยังไม่ใช้", ...copy });
  }

  for (let pass = 0; pass < 2 && drafts.some((d) => itemViolates(d, drafts, productName)); pass++) {
    const again = await callWithJsonRetry(
      userId,
      user,
      versionsPrompt(req, family, clamped.n) + "\nบางเวอร์ชันซ้ำชุดหรือข้อความ — เขียนใหม่ให้ครบกฎความต่าง",
      parsePlanVersionsJson,
      VERSION_JSON_SCHEMA,
    );
    if (!again.ok) break;
    drafts = repairDrafts(again.value.versions.slice(0, clamped.n), family, productName);
    while (drafts.length < clamped.n) {
      const next = pickUnusedSubset(family, drafts);
      if (!next) break;
      const copy = fallbackCopy(drafts.length, productName, drafts.map((d) => d.headline), drafts.map((d) => d.caption));
      drafts.push({ sequence: next, overlays: [], rationale: "เติมชุดที่ยังไม่ใช้", ...copy });
    }
  }
  drafts = repairDrafts(drafts.slice(0, clamped.n), family, productName);
  const versions = finalizeVersions(drafts, req.talking, productIds);
  return { ok: true, maxVersions: clamped.maxVersions, clampedReason: clamped.clampedReason, versions };
}

function fallbackSplitCopy(index: number, productName: string): { headline: string; caption: string; reason: string } {
  const ord = uniqueThaiOrdinal(index);
  return {
    headline: `ช่วง${ord}ที่คนดูควรได้ยิน`,
    caption: `สรุปประเด็นช่วง${ord}ของ${productName}`,
    reason: "ตัดตามขอบประโยคในทรานสคริปต์ ให้ช่วงยาวพอและไม่ทับกัน",
  };
}

function splitPrompt(footageId: string, spans: { start: number; end: number }[], transcript: TranscriptSegment[], productHint: string): string {
  const spanLines = spans.map((s, i) => {
    const text = transcript.filter((t) => t.start >= s.start - 0.01 && t.end <= s.end + 0.01).map((t) => t.text).join(" ");
    return `[${i}] ${s.start}-${s.end}: ${text}`;
  }).join("\n");
  return `${headlineRules()}

วางแผนแตกคลิปจาก Talking Footage ${footageId}
ช่วงที่ตัดแล้ว (ห้ามย้ายขอบ — เขียน headline/caption/reason ตามลำดับนี้):
${spanLines}

สินค้าอ้างอิง: ${productHint}

ตอบ JSON เท่านั้น:
{"segments":[{"start":0,"end":30,"headline":"...","caption":"...","reason":"..."}]}`;
}

export async function planSplitSegments(
  userId: string,
  user: { geminiKey: string | null; plan: string },
  input: { footageId: string; durationSec: number; transcript: TranscriptSegment[]; productName?: string },
): Promise<
  | { ok: true; segments: { start: number; end: number; headline: string; caption: string; reason: string }[] }
  | { ok: false; error: PlanModelError }
> {
  const spans = proposeSplitSpans(input.transcript, input.durationSec);
  const productName = input.productName ?? "";
  if (spans.length === 0) return { ok: true, segments: [] };

  const first = await callWithJsonRetry(
    userId,
    user,
    splitPrompt(input.footageId, spans, input.transcript, productName || input.footageId),
    parsePlanSplitJson,
    SPLIT_JSON_SCHEMA,
  );
  let texts: ModelSplitDraft[] = first.ok ? first.value.segments : [];
  if (!first.ok && first.error.kind === "quota") return first;
  if (!first.ok && first.error.kind === "provider") return first;

  const segments = spans.map((span, i) => {
    const fromModel = texts[i];
    const headline = fromModel?.headline ?? "";
    const caption = fromModel?.caption ?? "";
    const reason = fromModel?.reason ?? "";
    if (headline && caption && reason && passesThaiOutput(headline, productName) && passesThaiOutput(caption, productName)) {
      return { start: span.start, end: span.end, headline, caption, reason };
    }
    return { start: span.start, end: span.end, ...fallbackSplitCopy(i, productName || "สินค้า") };
  });
  return { ok: true, segments };
}

export { proposeSplitSpans };
