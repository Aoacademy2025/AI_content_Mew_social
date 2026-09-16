import assert from "node:assert/strict";
import {
  readHeroScriptWritingPreferences,
  switchHeroScriptWorkspaceTab,
  type HeroScriptWorkspaceState,
} from "../src/app/(dashboard)/hero-script/_components/hero-script-workspace-state";

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

console.log("verify-hero-script-workspace: PASS retained workspace and account-scoped preferences");
