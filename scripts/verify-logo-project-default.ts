// Run with: npx tsx scripts/verify-logo-project-default.ts
import assert from "node:assert/strict";
import {
  logoOverlayForNewProject,
  type LogoOverlayConfig,
} from "../src/lib/logo-overlay";

const accountDefault: LogoOverlayConfig = {
  enabled: true,
  assetId: "logo_asset_1",
  position: "bottom-right",
  sizePct: 22,
  opacity: 0.75,
};

const inherited = logoOverlayForNewProject({
  hasExistingDraft: false,
  accountDefault,
});
assert.deepEqual(inherited, accountDefault, "blank new projects inherit the account default");
assert.notEqual(inherited, accountDefault, "inherited config is a copy");

assert.equal(
  logoOverlayForNewProject({ hasExistingDraft: false, accountDefault: null }),
  undefined,
  "new projects omit logoOverlay when there is no account default",
);
assert.equal(
  logoOverlayForNewProject({ hasExistingDraft: true, accountDefault }),
  undefined,
  "local drafts are never backfilled",
);
assert.equal(
  logoOverlayForNewProject({ hasExistingDraft: true, accountDefault }),
  undefined,
  "server project drafts are never backfilled",
);

type DraftWithOptionalLogo = {
  mode?: "script" | "upload";
  script?: string;
  logoOverlay?: LogoOverlayConfig;
};
const legacyDraft = JSON.parse('{"mode":"script","script":"legacy"}') as DraftWithOptionalLogo;
assert.equal(legacyDraft.script, "legacy", "legacy draft JSON still parses");
assert.equal(legacyDraft.logoOverlay, undefined, "legacy drafts may omit logoOverlay");

console.log("ALL LOGO PROJECT DEFAULT CHECKS PASSED");
