import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FIRST_CLIP_STARTERS,
  shouldApplyFirstClipStarterScript,
} from "@/lib/first-clip-starter";

const REPO_ROOT = path.resolve(__dirname, "..");

function readRepo(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function main() {
  const dashboardSrc = readRepo("src/app/(dashboard)/dashboard/page.tsx");
  const returnLoopSrc = readRepo("src/components/dashboard/return-loop-card.tsx");
  const step1Src = readRepo("src/app/(dashboard)/video-editor/_v2/Step1Script.tsx");

  // 1. Dashboard: Banner deduplication (GrantExpiryBanner suppresses DashboardFounderBanner)
  assert.match(
    dashboardSrc,
    /<GrantExpiryBanner\s+grant=\{stats\?\.expiringGrant\}\s+surface="dashboard"\s*\/>/,
    "Dashboard renders GrantExpiryBanner",
  );
  assert.match(
    dashboardSrc,
    /\{!stats\?\.expiringGrant\s*&&\s*<DashboardFounderBanner\s+plan=\{stats\?\.plan\}\s*\/>\}/,
    "Dashboard suppresses DashboardFounderBanner whenever expiringGrant is active",
  );

  // 2. Dashboard: Legacy /style and /content cards removed; Thai expiry pills
  assert.doesNotMatch(
    dashboardSrc,
    /href:\s*"\/style"|href="\/style"/,
    "Dashboard no longer links to legacy /style stat card",
  );
  assert.doesNotMatch(
    dashboardSrc,
    /href="\/content"|Recent Content/,
    "Dashboard no longer renders legacy Recent Content (/content) card",
  );
  assert.match(dashboardSrc, /เหลือ \$\{d\} วัน/, "Dashboard translates remaining days pill to Thai");
  assert.match(dashboardSrc, /หมดอายุแล้ว/, "Dashboard translates Expired pill to Thai");
  assert.doesNotMatch(dashboardSrc, /d remaining|"Expired"/, "Dashboard removes legacy English expiry pill copy");

  // 3. Dashboard: Upgraded creator-focused Thai QuickCards
  assert.match(dashboardSrc, /label="สร้างวิดีโอใหม่"[\s\S]*?href="\/video-editor"/, "Returning QuickCard: สร้างวิดีโอใหม่");
  assert.match(dashboardSrc, /label="เขียนสคริปต์ AI"[\s\S]*?href="\/hero-script"/, "Returning QuickCard: เขียนสคริปต์ AI");
  assert.match(dashboardSrc, /label="แบรนด์ของฉัน"[\s\S]*?href="\/brands"/, "Returning QuickCard: แบรนด์ของฉัน");
  assert.match(dashboardSrc, /label="คลังวิดีโอ"[\s\S]*?href="\/videos"/, "Returning QuickCard: คลังวิดีโอ");
  assert.doesNotMatch(dashboardSrc, /label="วิธีใช้งาน"/, "Returning QuickCards replace legacy วิธีใช้งาน card");

  // 4. Dashboard: Recent Videos rows are clickable Links with Thai status labels and >=44px target
  const recentVideosBlock = dashboardSrc.slice(dashboardSrc.indexOf("Recent Videos"));
  assert.match(
    recentVideosBlock,
    /<Link[\s\S]*?key=\{v\.id\}[\s\S]*?href="\/videos"[\s\S]*?min-h-\[44px\]/,
    "Recent Videos rows are clickable Links to /videos with min-h-[44px] touch target",
  );
  assert.match(dashboardSrc, /เสร็จแล้ว/, "Recent Videos uses Thai COMPLETED status label");
  assert.match(dashboardSrc, /กำลังสร้าง/, "Recent Videos uses Thai PROCESSING status label");
  assert.match(dashboardSrc, /ไม่สำเร็จ/, "Recent Videos uses Thai FAILED status label");

  // 5. ReturnLoopCard: secondary '+ เริ่มคลิปใหม่' CTA on unfinished states + telemetry
  assert.match(
    returnLoopSrc,
    /!finished\s*&&\s*!action\.secondaryHref/,
    "ReturnLoopCard shows secondary fresh-start CTA when unfinished and no existing secondaryHref",
  );
  assert.match(
    returnLoopSrc,
    /href="\/video-editor\?ui=v2&empty=1"[\s\S]*?onClick=\{\(\)\s*=>\s*trackClick\("new_clip"\)\}[\s\S]*?\+ เริ่มคลิปใหม่/,
    "ReturnLoopCard links '+ เริ่มคลิปใหม่' to /video-editor?ui=v2&empty=1 and emits target:'new_clip'",
  );
  assert.match(
    returnLoopSrc,
    /trackEvent\("return_loop_clicked"/,
    "ReturnLoopCard emits return_loop_clicked telemetry",
  );

  // 6. Step1Script: empty-state 1-click Sample Script & AI Script helper + non-overwrite guard
  assert.match(
    step1Src,
    /p\.mode === "script"\s*&&\s*!lines\.length/,
    "Step1Script only renders empty-state starter strip when in script mode and script is empty",
  );
  assert.match(
    step1Src,
    /shouldApplyFirstClipStarterScript\(p\.script\)/,
    "Step1Script guards sample insertion with shouldApplyFirstClipStarterScript so non-empty text is never overwritten",
  );
  assert.match(
    step1Src,
    /FIRST_CLIP_STARTERS\[0\]/,
    "Step1Script reuses FIRST_CLIP_STARTERS[0] from src/lib/first-clip-starter.ts",
  );
  assert.match(
    step1Src,
    /ลองสคริปต์ตัวอย่าง 30 วิ \(1 คลิก\)/,
    "Step1Script shows 1-click 30s sample script button",
  );
  assert.match(
    step1Src,
    /href="\/hero-script"[\s\S]*?ให้ AI เขียนสคริปต์ให้/,
    "Step1Script shows link to /hero-script ('ให้ AI เขียนสคริปต์ให้')",
  );
  assert.match(
    step1Src,
    /trackEvent\("step1_empty_starter_clicked"[\s\S]*?kind:\s*"sample_script"/,
    "Step1Script tracks sample_script clicks",
  );
  assert.match(
    step1Src,
    /trackEvent\("step1_empty_starter_clicked"[\s\S]*?kind:\s*"hero_script"/,
    "Step1Script tracks hero_script clicks",
  );

  // Runtime guard sanity check
  assert.ok(FIRST_CLIP_STARTERS[0].script.split("\n").length >= 5, "FIRST_CLIP_STARTERS[0] has a multi-segment Thai script");
  assert.equal(shouldApplyFirstClipStarterScript(""), true);
  assert.equal(shouldApplyFirstClipStarterScript("   \n"), true);
  assert.equal(shouldApplyFirstClipStarterScript("สคริปต์ที่พิมพ์ไว้แล้ว"), false);

  console.log(
    "verify-hero-115-dashboard-step1: PASS — banner dedupe, clean returning dashboard, clickable Recent Videos, ReturnLoopCard fresh-start CTA, and Step 1 empty starter helpers verified",
  );
}

main();
