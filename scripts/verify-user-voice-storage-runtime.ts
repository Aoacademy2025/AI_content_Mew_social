import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function sineWav(sampleRate = 24_000, durationMs = 7_000): Buffer {
  const sampleCount = Math.round(sampleRate * durationMs / 1_000);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 220 / sampleRate) * 8_000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main() {
  const [{ prisma }, voices] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/user-voices.server"),
  ]);
  const privateStorage = process.env.USER_VOICE_STORAGE_DIR!;
  process.env.USER_VOICE_STORAGE_DIR = path.join(process.cwd(), "public", "voice-reference-test");
  assert.throws(
    () => voices.userVoicesDir(),
    (error: unknown) => error instanceof voices.UserVoiceError
      && error.code === "USER_VOICE_STORAGE_INVALID",
  );
  process.env.USER_VOICE_STORAGE_DIR = privateStorage;

  const user = await prisma.user.create({
    data: { name: "Voice storage test", email: "voice-storage@test.invalid", role: "ADMIN" },
  });
  const audio = sineWav();
  await assert.rejects(
    () => voices.createUserVoice({
      userId: user.id,
      name: "ไม่ได้ยืนยันสิทธิ์",
      refText: "นี่คือข้อความเสียงสำหรับทดสอบระบบ",
      audio,
      consent: false,
    }),
    (error: unknown) => error instanceof voices.UserVoiceError
      && error.code === "USER_VOICE_CONSENT_REQUIRED",
  );

  const created = await voices.createUserVoice({
    userId: user.id,
    name: " เสียง   ทดสอบ ",
    refText: "นี่คือข้อความเสียงสำหรับทดสอบระบบ",
    audio,
    consent: true,
  });
  assert.equal(created.name, "เสียง ทดสอบ");
  assert.ok(created.durationMs >= voices.MIN_REF_MS && created.durationMs <= voices.MAX_REF_MS);
  assert.equal(created.consentVersion, voices.USER_VOICE_CONSENT_VERSION);
  assert.equal((await voices.listUserVoices(user.id)).length, 1);

  const storedPath = path.join(process.env.USER_VOICE_STORAGE_DIR!, created.filename);
  assert.equal(fs.existsSync(storedPath), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(storedPath).mode & 0o777, 0o600);
  const preview = await voices.readUserVoiceWav(user.id, created.id);
  assert.ok(preview?.wav.length);
  const ref = await voices.loadUserVoiceRef(user.id, voices.userVoiceIdFor(created.id));
  assert.equal(ref?.refText, created.refText);
  assert.ok(ref?.audioBase64.length);

  assert.equal(await voices.deleteUserVoice(user.id, created.id), true);
  assert.equal(fs.existsSync(storedPath), false);
  assert.equal((await voices.listUserVoices(user.id)).length, 0);
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  console.log("Private user-voice normalize/store/read/delete runtime checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
