import assert from "node:assert/strict";
import {
  loadLatestHeroScriptDetail,
  readHeroScriptWritingPreferences,
  switchHeroScriptWorkspaceTab,
  type HeroScriptWorkspaceState,
} from "../src/app/(dashboard)/hero-script/_components/hero-script-workspace-state";

async function verify() {
const profiles = [{ id: "legacy-revision-zero" }, { id: "published-profile" }];

const workspace: HeroScriptWorkspaceState = {
  activeTab: "write",
  topic: "ทดลองหัวข้อ",
  selectedHook: { formula: "question", text: "ประโยคเปิด", contextKey: "fixture" },
  draft: { id: "draft-fixture", hookText: "ประโยคเปิด", bodyText: "เนื้อหาทดสอบ", ctaText: "ชวนทำต่อ" },
};

assert.deepEqual(switchHeroScriptWorkspaceTab(workspace, "library"), {
  ...workspace,
  activeTab: "library",
}, "switching to the library keeps the topic, selected Hook, and working draft");

const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null };
values.set("hero-script-writing:account-a", JSON.stringify({ profileId: "legacy-revision-zero", durationSec: 90 }));
assert.deepEqual(
  readHeroScriptWritingPreferences(storage, "account-a", profiles),
  { profileId: "legacy-revision-zero", durationSec: 90 },
  "an account restores only its own valid profile and duration preference",
);
assert.deepEqual(
  readHeroScriptWritingPreferences(storage, "account-b", profiles),
  { profileId: null, durationSec: 60 },
  "another account does not inherit the previous account's preferences",
);
values.set("hero-script-writing:account-a", JSON.stringify({ profileId: "unavailable-profile", durationSec: 45 }));
assert.deepEqual(
  readHeroScriptWritingPreferences(storage, "account-a", profiles),
  { profileId: null, durationSec: 60 },
  "an unavailable remembered profile or duration falls back to explicit no-profile defaults",
);

type Detail = { id: string; topic: string };
const pending = new Map<string, (response: Response) => void>();
const fetcher = (input: string | URL) => new Promise<Response>((resolve) => {
  pending.set(String(input), resolve);
});
const latestDetail = { current: 0 };
const older = loadLatestHeroScriptDetail<Detail>("older", latestDetail, fetcher);
const newer = loadLatestHeroScriptDetail<Detail>("newer", latestDetail, fetcher);
pending.get("/api/scripts/newer")?.(Response.json({ id: "newer", topic: "หัวข้อใหม่" }));
assert.deepEqual(await newer, { status: "applied", data: { id: "newer", topic: "หัวข้อใหม่" } });
pending.get("/api/scripts/older")?.(Response.json({ id: "older", topic: "หัวข้อเก่า" }));
assert.deepEqual(await older, { status: "stale" }, "a delayed record cannot replace the newest explicit selection");

const deleted = loadLatestHeroScriptDetail<Detail>("deleted", latestDetail, fetcher);
latestDetail.current += 1;
pending.get("/api/scripts/deleted")?.(Response.json({ id: "deleted", topic: "ถูกลบแล้ว" }));
assert.deepEqual(await deleted, { status: "stale" }, "deletion invalidates a racing restore response");

console.log("verify-hero-script-workspace: PASS retained workspace, account preferences, and latest-only full-detail restore");
}

void verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
