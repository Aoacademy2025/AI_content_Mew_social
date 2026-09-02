import type { BrandProfilePayload } from "@/lib/brand-profile-library.server";
import { createBlankBrandProfileSeed } from "@/lib/brand-profile-seed";
import { TREATMENT_PRESET_IDS, type TreatmentPresetId } from "@/lib/brand-treatment-catalog";
import { STYLE_PACKS, isStylePackId, stylePack, type StylePack } from "@/lib/style-pack-catalog";

/** A pack is a one-tap layer over the EXISTING Brand Profile axes (ADR 0058):
 * it resolves Visual Format, narrative treatment, palette, personality,
 * subtitle and script tone onto the payload the creator already had. It adds
 * no new rendering path — pinning, revisions and the compilers stay untouched. */

/** Customer-visible Thai copy. A pack still awaiting the Treatment
 * Qualification Benchmark (ADR 0010) is never selectable (ADR 0058). */
export const STYLE_PACK_UNAVAILABLE_MESSAGE = "ชุดสไตล์นี้ยังไม่เปิดให้ใช้";

function qualifiedTreatmentPresetId(pack: StylePack): TreatmentPresetId {
  // Wave 2 packs name treatments that do not exist in the closed catalog yet.
  // Their `pending-benchmark` status already blocks them above; this keeps the
  // payload honest if a catalog edit ever activates a pack before its treatment.
  if (!(TREATMENT_PRESET_IDS as readonly string[]).includes(pack.treatmentPresetId)) {
    throw new Error(STYLE_PACK_UNAVAILABLE_MESSAGE);
  }
  return pack.treatmentPresetId as TreatmentPresetId;
}

let packOwnedTones: Set<string> | null = null;

/** A tone nobody authored: the blank-seed default, or the tone some pack put
 * there. Every other pack-resolved field is replaced on every apply, so tone
 * must be too — otherwise the second pack a creator taps keeps speaking in the
 * first pack's voice. Pending packs count as well: what matters is that the
 * words came from the catalog, not from the creator. Anything else is their
 * writing and is kept, no matter how many packs are tried on top. */
function isPackOwnedTone(tone: string): boolean {
  if (!packOwnedTones) {
    packOwnedTones = new Set<string>([
      createBlankBrandProfileSeed().script.tone,
      ...STYLE_PACKS.map((pack) => pack.scriptTone),
    ]);
  }
  return packOwnedTones.has(tone);
}

/** Apply one pack onto a Brand Profile payload. Pure: the caller's payload is
 * never mutated. Two creator-authored fields win over the pack: a saved
 * subtitle style (`subtitle.presetId`) and a tone the creator wrote themselves
 * (anything `isPackOwnedTone` does not recognise). */
export function applyStylePackToPayload(
  payload: BrandProfilePayload,
  pack: StylePack,
): BrandProfilePayload {
  if (pack.status !== "active") throw new Error(STYLE_PACK_UNAVAILABLE_MESSAGE);
  const lockedTreatmentPresetId = qualifiedTreatmentPresetId(pack);
  const keepsOwnSubtitle = Boolean(payload.subtitle.presetId);
  const keepsOwnTone = !isPackOwnedTone(payload.script.tone);
  return {
    ...payload,
    script: {
      ...payload.script,
      tone: keepsOwnTone ? payload.script.tone : pack.scriptTone,
    },
    subtitle: keepsOwnSubtitle
      ? { ...payload.subtitle, config: { ...payload.subtitle.config } }
      : { ...payload.subtitle, config: { ...pack.subtitle } },
    visual: {
      ...payload.visual,
      stylePackId: pack.id,
      stylePackVersion: pack.version,
      primaryVisualFormatId: pack.visualFormatId,
      treatmentPolicy: "locked",
      lockedTreatmentPresetId,
      palette: [...pack.palette],
      personality: pack.personality,
    },
  };
}

/** Unlink the pack while keeping everything it resolved: the look the creator
 * is looking at does not change, it simply becomes their own custom look. */
export function clearStylePack(payload: BrandProfilePayload): BrandProfilePayload {
  return {
    ...payload,
    visual: { ...payload.visual, stylePackId: null, stylePackVersion: null },
  };
}

/** The pack a payload is currently linked to, or null for a custom look. */
export function stylePackOfPayload(payload: BrandProfilePayload): StylePack | null {
  const id = payload.visual.stylePackId;
  return id && isStylePackId(id) ? stylePack(id) : null;
}
