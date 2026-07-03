// verify-v2-bgm-path.ts — เพลง v2: system → /music/<f> · user → /api/music/<f> · ไม่เลือก → ไม่ส่ง
// Run: npx tsx scripts/verify-v2-bgm-path.ts
function bgmFileFor(musicTrack: string | null, kind: "system" | "user"): string | undefined {
  // สูตรเดียวกับ useV2Job.ts submit — คัดลอกมาทดสอบ logic (hook รันนอก React ไม่ได้)
  return musicTrack ? (kind === "user" ? `/api/music/${musicTrack}` : `/music/${musicTrack}`) : undefined;
}
let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${String(got)} want=${String(want)}`);
  if (!ok) fail++;
}
eq("system track", bgmFileFor("calm.mp3", "system"), "/music/calm.mp3");
eq("user track", bgmFileFor("user-1-abc.mp3", "user"), "/api/music/user-1-abc.mp3");
eq("none (null)", bgmFileFor(null, "system"), undefined);
eq("none (empty)", bgmFileFor("", "system"), undefined);
process.exit(fail ? 1 : 0);
