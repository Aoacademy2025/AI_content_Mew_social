import type { ActiveStylePackId } from "@/lib/style-pack-catalog";

export type FirstClipStarter = {
  templateId: ActiveStylePackId;
  title: string;
  subtitle: string;
  script: string;
};

/**
 * HERO-104: Proven high-adoption Styled Video Templates paired with ready-to-render
 * ~25-30s Thai starter scripts (1 line = 1 segment) so new Trial creators can launch
 * clip #1 in 1 click without blank-page copy-paste friction.
 */
export const FIRST_CLIP_STARTERS: readonly FirstClipStarter[] = [
  {
    templateId: "news-fast",
    title: "ข่าวไว / สรุปประเด็น",
    subtitle: "ซับเด้งจังหวะเร็ว · เหมาะกับอัปเดตข่าวและเทรนด์",
    script: [
      "3 นิสัยที่ทำให้คลิปแรกของคุณไม่มีคนดู",
      "ข้อแรก เปิดคลิปช้าเกินไป คนเลื่อนผ่านตั้งแต่ 2 วินาทีแรก",
      "ข้อสอง พูดยาวรวดเดียวไม่มีจังหวะหยุด คนฟังตามไม่ทัน",
      "ข้อสาม ไม่มีซับ คนดูส่วนใหญ่เปิดคลิปแบบปิดเสียง",
      "แก้สามข้อนี้ คลิปต่อไปของคุณไปได้ไกลกว่าเดิมแน่นอน",
      "กดติดตามไว้ พรุ่งนี้มาต่อเรื่องการเขียนฮุกให้คนหยุดดู",
    ].join("\n"),
  },
  {
    templateId: "finance-clear",
    title: "ความรู้ / การเงิน",
    subtitle: "โทนคมชัดน่าเชื่อถือ · เน้นเลขและประเด็นสำคัญ",
    script: [
      "ทำไมเงินเดือนขึ้นทุกปี แต่เงินเก็บยังไม่เพิ่ม",
      "คนส่วนใหญ่มักใช้ก่อนแล้วค่อยเก็บ ทำให้ปลายเดือนเหลือศูนย์",
      "ลองสลับเป็นสูตรออมก่อนใช้ แยก 10 เปอร์เซ็นต์ตั้งแต่วันเงินเดือนออก",
      "ไม่ต้องเริ่มเยอะ แค่ทำให้สม่ำเสมอทุกเดือนจนเป็นนิสัย",
      "ปีหน้าคุณจะเห็นความต่างของเงินในบัญชีแบบชัดเจน",
      "เซฟคลิปนี้ไว้เตือนตัวเองวันเงินเดือนออกได้เลย",
    ].join("\n"),
  },
  {
    templateId: "life-drama",
    title: "เล่าเรื่อง / แรงบันดาลใจ",
    subtitle: "อารมณ์ชวนฟัง · เหมาะกับคลิปเล่าประสบการณ์",
    script: [
      "วันที่เหนื่อยที่สุด อาจเป็นวันที่คุณกำลังโตขึ้นมากที่สุด",
      "หลายคนอยากล้มเลิก เพราะยังไม่เห็นผลลัพธ์ในสัปดาห์แรก",
      "แต่ทุกคลิปที่คุณลงมือทำ คือการฝึกทักษะที่คนไม่เริ่มไม่มีวันได้",
      "ไม่ต้องรอให้พร้อมร้อยเปอร์เซ็นต์ แค่เริ่มจากคลิปแรกวันนี้",
      "อีก 30 วันข้างหน้า คุณจะขอบคุณตัวเองที่ไม่ยอมแพ้",
      "ส่งคลิปนี้ให้คนที่กำลังต้องการกำลังใจวันนี้",
    ].join("\n"),
  },
] as const;

export function findFirstClipStarter(templateId: string | null | undefined): FirstClipStarter | null {
  if (!templateId) return null;
  return FIRST_CLIP_STARTERS.find((item) => item.templateId === templateId) ?? null;
}

export function firstClipStarterHref(templateId: ActiveStylePackId): string {
  return `/video-editor?templateId=${encodeURIComponent(templateId)}&sample=1&source=first_clip_starter`;
}

/**
 * Guard against overwriting an existing user draft when hydrating `?templateId=...&sample=1`.
 */
export function shouldApplyFirstClipStarterScript(currentScript: string): boolean {
  return currentScript.trim().length === 0;
}
