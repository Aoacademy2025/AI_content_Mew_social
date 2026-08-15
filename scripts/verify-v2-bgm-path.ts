// verify-v2-bgm-path.ts — payload เพลงเดียวกันใช้ได้ทั้ง script และ upload
// Run: npx tsx scripts/verify-v2-bgm-path.ts
import { readFileSync } from "node:fs";
import { buildBgmSelectionInput } from "../src/lib/bgm-selection";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!ok) fail++;
}

eq("system track", buildBgmSelectionInput("calm.mp3", "system", 0.18), { bgmFile: "/music/calm.mp3", bgmVolume: 0.18 });
eq("user track", buildBgmSelectionInput("user-1-abc.mp3", "user", 0.12), { bgmFile: "/api/music/user-1-abc.mp3", bgmVolume: 0.12 });
eq("none (null)", buildBgmSelectionInput(null, "system", 0.12), {});
eq("none (empty)", buildBgmSelectionInput("", "system", 0.12), {});
eq("volume clamp", buildBgmSelectionInput("calm.mp3", "system", 2), { bgmFile: "/music/calm.mp3", bgmVolume: 1 });

const submitSource = readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Job.ts", "utf8");
eq("script + upload submit include selected BGM", submitSource.match(/\.\.\.bgmInput/g)?.length, 2);

const step2Source = readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
const musicSection = step2Source.slice(step2Source.indexOf("{/* 3 · เพลงประกอบ */}"), step2Source.indexOf("{/* 4 · อวตารพิธีกร */}"));
eq("upload Step 2 exposes the music group", musicSection.includes('p.mode !== "upload"'), false);
eq("upload summary shows selected music", step2Source.match(/<SummaryRow label="เพลง"/g)?.length, 2);

const jobsRouteSource = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
eq("upload job is not stripped of BGM", jobsRouteSource.includes("!uploadMode && bgmFile"), false);

const compositeSource = readFileSync("src/app/api/heygen/composite/route.ts", "utf8");
eq("cutaway can preserve background mix", compositeSource.includes('audioFromBackground ? "0:a?" : "1:a?"'), true);

const orchestratorSource = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
eq(
  "initial preview and B-roll re-render both preserve upload BGM",
  orchestratorSource.match(/cutawayAudioFromBackground:/g)?.length,
  2,
);

process.exit(fail ? 1 : 0);
