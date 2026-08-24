// โปรโมทเสียงโคลนของผู้ใช้ (UserVoice ใน DB) ขึ้นเป็นเสียง preset ของ Hero Voice
// โดยเพิ่ม entry เข้า voices.json ของ OmniVoice server + คัดลอกไฟล์ ref ไปวางคู่กัน
//
// ใช้:
//   npx tsx scripts/promote-voice.ts                          ← ดูรายการเสียงโคลนทั้งหมด
//   npx tsx scripts/promote-voice.ts --voice <id|user_id> --id voice_49 \
//     --desc "เสียงผู้ชาย อบอุ่น" [--instruct "male"] [--voices-dir E:\omnivoice\voices]
//
// หลังรัน: restart OmniVoice server (โหลด manifest ตอนบูต) แล้วเสียงใหม่จะโผล่ใน /voices
// หมายเหตุ: backend runpod ต้อง rebuild image — สคริปต์นี้ครอบคลุมเฉพาะ server แบบไฟล์ (hostinger/local)

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type ManifestEntry = {
  id: string;
  desc: string;
  instruct: string;
  ref_audio: string;
  ref_text: string;
};

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

async function main() {
  const voiceArg = arg("voice");

  if (!voiceArg) {
    const voices = await prisma.userVoice.findMany({ orderBy: { createdAt: "desc" } });
    if (!voices.length) { console.log("ยังไม่มีเสียงโคลนใน DB"); return; }
    console.log("เสียงโคลนที่โปรโมทได้ (ใช้ค่าในคอลัมน์ id กับ --voice):\n");
    for (const voice of voices) {
      console.log(`  id=${voice.id}  ชื่อ="${voice.name}"  ยาว=${(voice.durationMs / 1000).toFixed(1)}วิ  ไฟล์=${voice.filename}`);
      console.log(`    refText: ${voice.refText.slice(0, 80)}${voice.refText.length > 80 ? "…" : ""}\n`);
    }
    return;
  }

  const newId = arg("id");
  const desc = arg("desc");
  const instruct = arg("instruct") ?? "";
  const voicesDir = arg("voices-dir") ?? "E:\\omnivoice\\voices";

  if (!newId || !/^[A-Za-z0-9_-]{1,64}$/.test(newId)) throw new Error("--id ต้องเป็น a-z 0-9 _ - (เช่น voice_49)");
  if (!desc) throw new Error("--desc ต้องระบุ (คำอธิบายเสียงที่ผู้ใช้จะเห็น)");

  const manifestPath = path.join(voicesDir, "voices.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`ไม่พบ manifest: ${manifestPath}`);

  // รับได้ทั้ง id ตรงๆ และรูป user_<id> ที่เห็นใน UI
  const dbId = voiceArg.startsWith("user_") ? voiceArg.slice(5) : voiceArg;
  const voice = await prisma.userVoice.findUnique({ where: { id: dbId } });
  if (!voice || voice.filename === "pending") throw new Error(`ไม่พบเสียงโคลน id=${dbId} ใน DB`);

  const sourceWav = path.join(process.cwd(), "uploads", "user-voices", voice.filename);
  if (!fs.existsSync(sourceWav)) throw new Error(`ไฟล์ ref หาย: ${sourceWav}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ManifestEntry[];
  if (!Array.isArray(manifest)) throw new Error("voices.json ไม่ใช่ array");
  if (manifest.some((entry) => entry.id === newId)) throw new Error(`id "${newId}" มีอยู่แล้วใน manifest`);

  const targetWav = path.join(voicesDir, `${newId}.wav`);
  if (fs.existsSync(targetWav)) throw new Error(`ไฟล์ปลายทางมีอยู่แล้ว: ${targetWav}`);

  // สำรอง manifest ก่อนแตะ (กู้คืนได้เสมอ)
  const backupPath = `${manifestPath}.bak-${Date.now()}`;
  fs.copyFileSync(manifestPath, backupPath);

  fs.copyFileSync(sourceWav, targetWav);
  manifest.push({ id: newId, desc, instruct, ref_audio: `${newId}.wav`, ref_text: voice.refText });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`✓ โปรโมท "${voice.name}" → ${newId} สำเร็จ`);
  console.log(`  ไฟล์เสียง: ${targetWav}`);
  console.log(`  manifest:  ${manifestPath} (สำรองไว้ที่ ${path.basename(backupPath)})`);
  console.log("\nขั้นต่อไป: restart OmniVoice server แล้วเสียงใหม่จะอยู่ในรายการ Hero Voice ทันที");
  console.log("(ถ้าใช้ backend runpod ต้องเอาโฟลเดอร์ voices นี้ไป rebuild image ด้วย)");
}

main()
  .catch((error) => { console.error("ERROR:", error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
