import { stylePack, type StylePackId } from "@/lib/style-pack-catalog";
import { VISUAL_FORMATS } from "@/lib/brand-visual-system";
import manifest from "@/lib/style-pack-sample-manifest.json";

export type StylePackSample = {
  status: "illustrative" | "unavailable";
  imageUrl: string | null;
  label: string;
};

/** Reviewed real outputs, with the exact catalog identity recorded. A changed
 * recipe cannot silently keep an old sample. They illustrate the pack, not
 * every account override or guaranteed adherence to an unseen script. */
export function stylePackSample(id: StylePackId): StylePackSample {
  const sample = manifest.entries.find((item) => item.id === id);
  const pack = stylePack(id);
  const format = VISUAL_FORMATS.find((item) => item.id === pack.visualFormatId);
  const matches = sample && sample.packVersion === pack.version && sample.recipeVersion === format?.recipeVersion
    && sample.visualFormatId === pack.visualFormatId && sample.treatmentPresetId === pack.treatmentPresetId
    && sample.visualIdentity === JSON.stringify({ palette: pack.palette, personality: pack.personality });
  return matches
    ? { status: "illustrative", imageUrl: sample.imageUrl, label: "ภาพ AI ตัวอย่าง · รายละเอียดคลิปจริงอาจต่างกัน" }
    : { status: "unavailable", imageUrl: null, label: "ภาพตัวอย่างยังไม่พร้อม · ยังเลือกสไตล์นี้ได้" };
}
