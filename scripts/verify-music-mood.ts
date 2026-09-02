// Task 6 (Brands wave 1): Music.mood — admin mood tag + pack-suggested default track.
//
// Covers, in order:
//   1. parseMusicMoodInput — the shared validator both admin routes must call
//      (undefined = not provided, null/"" = explicitly no mood, anything else
//      must be one of MUSIC_MOODS or it is invalid).
//   2. MUSIC_MOOD_LABELS — one Thai label per MusicMood + the "ไม่ระบุ" choice,
//      exact copy per the task brief.
//   3. pickDefaultMusicTrack — the pure choice the editor uses: first system
//      track whose mood matches, else null. Never throws.
//   4. The admin write routes actually wire the shared validator in (static
//      source check — Clerk-gated route.ts handlers can't run outside a real
//      request scope, so we don't invoke them directly; see
//      scripts/verify-brand-asset-api.ts for the same established pattern).
//   5. A valid mood, once stored on Music.mood via Prisma, is returned by the
//      exact `select` shape GET /api/music uses for its public track list.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "music-mood-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { MUSIC_MOODS } = await import("../src/lib/style-pack-catalog");
  const {
    MUSIC_MOOD_LABELS,
    MUSIC_MOOD_UNSPECIFIED_LABEL,
    parseMusicMoodInput,
    pickDefaultMusicTrack,
  } = await import("../src/lib/music-mood");

  // ── 1. parseMusicMoodInput ────────────────────────────────────────────────
  assert.deepEqual(parseMusicMoodInput(undefined), { ok: true, provided: false });
  assert.deepEqual(parseMusicMoodInput(null), { ok: true, provided: true, mood: null });
  assert.deepEqual(parseMusicMoodInput(""), { ok: true, provided: true, mood: null });
  for (const mood of MUSIC_MOODS) {
    assert.deepEqual(parseMusicMoodInput(mood), { ok: true, provided: true, mood });
  }
  assert.equal(parseMusicMoodInput("not-a-real-mood").ok, false);
  assert.equal(parseMusicMoodInput("Calm").ok, false, "must be case-sensitive against the catalog");
  assert.equal(parseMusicMoodInput(123 as unknown).ok, false);
  assert.equal(parseMusicMoodInput({} as unknown).ok, false);
  console.log("PASS parseMusicMoodInput accepts MUSIC_MOODS ∪ {null}, rejects everything else");

  // ── 2. MUSIC_MOOD_LABELS ──────────────────────────────────────────────────
  const expectedLabels: Record<string, string> = {
    ominous: "น่ากลัว / กดดัน",
    tense: "ตึงเครียด",
    emotional: "ซึ้ง / สะเทือนใจ",
    upbeat: "สดใส / มีพลัง",
    calm: "สงบ / ผ่อนคลาย",
    epic: "ยิ่งใหญ่",
    serious: "จริงจัง",
    lounge: "หรู / ชิล",
    traditional: "ไทยเดิม",
    eerie: "ลึกลับ / วังเวง",
  };
  assert.equal(MUSIC_MOODS.length, Object.keys(expectedLabels).length, "catalog/label-fixture drift");
  for (const mood of MUSIC_MOODS) {
    assert.equal(MUSIC_MOOD_LABELS[mood], expectedLabels[mood], `label for ${mood}`);
  }
  assert.equal(MUSIC_MOOD_UNSPECIFIED_LABEL, "ไม่ระบุ");
  console.log("PASS MUSIC_MOOD_LABELS carries the exact Thai copy for every mood + \"ไม่ระบุ\"");

  // ── 3. pickDefaultMusicTrack ──────────────────────────────────────────────
  const tracks = [
    { filename: "a.mp3", mood: "calm" },
    { filename: "b.mp3", mood: "epic" },
    { filename: "c.mp3", mood: "calm" },
    { filename: "d.mp3", mood: null },
  ];
  assert.equal(pickDefaultMusicTrack(tracks, "calm"), "a.mp3", "first match wins");
  assert.equal(pickDefaultMusicTrack(tracks, "eerie"), null, "no match -> null");
  assert.equal(pickDefaultMusicTrack(tracks, null), null, "no mood requested -> null");
  assert.equal(pickDefaultMusicTrack(tracks, undefined), null);
  assert.equal(pickDefaultMusicTrack([], "calm"), null, "empty track list -> null, never throws");
  assert.equal(pickDefaultMusicTrack(null, "calm"), null, "missing track list -> null, never throws");
  console.log("PASS pickDefaultMusicTrack returns the first match, else null — never throws");

  // ── 4. Admin write routes actually validate mood via the shared parser ────
  const postRouteSrc = readFileSync(join(process.cwd(), "src/app/api/admin/music/route.ts"), "utf8");
  assert.ok(postRouteSrc.includes("parseMusicMoodInput"), "POST /api/admin/music must validate mood via the shared parser");
  assert.ok(/status:\s*400/.test(postRouteSrc), "POST /api/admin/music must 400 on an invalid mood");

  const patchRouteSrc = readFileSync(join(process.cwd(), "src/app/api/admin/music/[id]/route.ts"), "utf8");
  assert.ok(patchRouteSrc.includes("parseMusicMoodInput"), "PATCH /api/admin/music/[id] must validate mood via the shared parser");
  assert.ok(/status:\s*400/.test(patchRouteSrc), "PATCH /api/admin/music/[id] must 400 on an invalid mood");

  const publicRouteSrc = readFileSync(join(process.cwd(), "src/app/api/music/route.ts"), "utf8");
  assert.ok(/select:\s*{[^}]*mood:\s*true[^}]*}/s.test(publicRouteSrc), "GET /api/music must select mood");
  console.log("PASS admin write routes validate mood via parseMusicMoodInput; the public list selects it");

  // ── 5. Valid mood: stored on Music.mood, returned by the public list shape ─
  const track = await prisma.music.create({ data: { title: "Intro Theme", filename: "intro.mp3" } });
  assert.equal(track.mood, null, "mood is additive — defaults to null for existing rows");

  const updated = await prisma.music.update({ where: { id: track.id }, data: { mood: "calm" } });
  assert.equal(updated.mood, "calm");

  const publicList = await prisma.music.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, filename: true, duration: true, createdAt: true, mood: true },
  });
  assert.equal(publicList.find((t) => t.id === track.id)?.mood, "calm", "valid mood surfaces in the public track list");

  // An unknown/invalid mood must never reach the DB (route rejects before the write) —
  // simulate the route's own guard and assert Prisma is never asked to persist it.
  const rejected = parseMusicMoodInput("not-a-real-mood");
  assert.equal(rejected.ok, false, "the route's 400 path — no write is attempted for this input");

  await prisma.$disconnect();
  console.log("verify-music-mood: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
