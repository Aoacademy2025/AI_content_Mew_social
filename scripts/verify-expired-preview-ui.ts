// Task 7 regression verifier: unavailable preview UX and editor integration.
// Run: npx tsx scripts/verify-expired-preview-ui.ts
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function main() {
const componentModule = await import(
  "../src/app/(dashboard)/video-editor/_v2/ExpiredPreviewView"
).catch(() => null);

check("unavailable preview view exists", componentModule !== null);

if (componentModule) {
  const { ExpiredPreviewView, selectUnavailablePreviewState, unavailablePreviewCopy } = componentModule;
  const expired = { status: "expired" as const, expiredAt: "2026-07-11T00:00:00.000Z", canRerender: true as const };
  const missing = { status: "missing" as const, canRerender: true, supportCode: "MEDIA_FILE_MISSING" };
  const unknownExpiry = { status: "missing" as const, canRerender: true, supportCode: "MEDIA_EXPIRY_UNKNOWN" };
  const expiredCopy = unavailablePreviewCopy(expired);
  const missingCopy = unavailablePreviewCopy(missing);
  const unknownExpiryCopy = unavailablePreviewCopy(unknownExpiry);

  check(
    "expired state uses the required package-retention copy",
    expiredCopy.description === "ไฟล์ Preview หมดอายุแล้วตามระยะเวลาของแพ็กเกจ กดสร้าง Preview ใหม่ได้",
    expiredCopy.description,
  );
  check("expired CTA copy is exact", expiredCopy.primaryAction === "สร้าง Preview ใหม่", expiredCopy.primaryAction);
  check("missing state is explicitly unexpected", /ไม่พร้อมใช้งานโดยไม่คาดคิด/.test(missingCopy.description), missingCopy.description);
  check("missing state exposes the support code", missingCopy.supportCode === "MEDIA_FILE_MISSING");
  check(
    "unknown-expiry incident does not claim the file disappeared before a known deadline",
    !unknownExpiryCopy.description.includes("ก่อนถึงวันหมดอายุ") && unknownExpiryCopy.description.includes("ไม่สามารถยืนยันวันหมดอายุ"),
    unknownExpiryCopy.description,
  );

  const expiredMarkup = renderToStaticMarkup(
    React.createElement(ExpiredPreviewView, { mediaState: expired, onRerender: () => undefined }),
  );
  const missingMarkup = renderToStaticMarkup(
    React.createElement(ExpiredPreviewView, { mediaState: missing, onRerender: () => undefined }),
  );
  check("expired unavailable view never renders a video element", !expiredMarkup.includes("<video"));
  check("missing unavailable view never renders a video element", !missingMarkup.includes("<video"));
  check("unavailable view exposes the rerender action", expiredMarkup.includes("สร้าง Preview ใหม่"));
  check("incident view exposes a support action", missingMarkup.includes("ติดต่อฝ่ายช่วยเหลือ"));
  check("incident markup contains its support code", missingMarkup.includes("MEDIA_FILE_MISSING"));

  check("unavailable state selector exists", typeof selectUnavailablePreviewState === "function");
  if (typeof selectUnavailablePreviewState === "function") {
    const doneWithoutState = selectUnavailablePreviewState({ phase: "done", mediaState: null });
    const pollingWithoutState = selectUnavailablePreviewState({ phase: "rendering", mediaState: null });
    check("done plus null media state fails closed", doneWithoutState?.supportCode === "MEDIA_EXPIRY_UNKNOWN");
    check("in-flight polling plus null media state remains in the normal rendering flow", pollingWithoutState === null);
    const unknownMarkup = renderToStaticMarkup(
      React.createElement(ExpiredPreviewView, { mediaState: doneWithoutState!, onRerender: () => undefined }),
    );
    check("done plus null media state can never reach a broken video", !unknownMarkup.includes("<video"));
  }
}

const jobSource = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Job.ts", "utf8");
const projectSource = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Project.ts", "utf8");
const shellSource = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx", "utf8");
const desktopSource = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "utf8");
const mobileSource = fs.readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", "utf8");

function hasSafeRerenderFlow(source: string) {
  const handlerBody = source.match(/function handlePreviewRerender\(\)\s*\{([^}]*)\}/)?.[1] ?? "";
  const resetIndex = handlerBody.indexOf("reset();");
  const confirmationIndex = handlerBody.indexOf("setStep(1);");
  return resetIndex >= 0 && confirmationIndex > resetIndex &&
    !/\bsubmit\s*\(/.test(handlerBody) &&
    !/resetProject\s*\(/.test(handlerBody) &&
    /<ExpiredPreviewView\s+mediaState=\{unavailableMediaState\}\s+onRerender=\{handlePreviewRerender\}/.test(source);
}

check("V2JobState carries ProjectMediaState", /mediaState:\s*ProjectMediaState\s*\|\s*null/.test(jobSource));
check("project detail hydrates previewMediaState", /setPreviewMediaState\(\(project\.previewMediaState/.test(projectSource));
check("job polling consumes API mediaState", /mediaState:\s*d\.mediaState/.test(jobSource));
check(
  "project-detail fallback is scoped to the job id that detail state describes",
  /detailMediaJobId/.test(jobSource) && /d\.id\s*===\s*detailMediaJobId/.test(jobSource),
);

const fullAssignments = jobSource.split("\n").filter((line) => line.includes("setJob({"));
check(
  "every full V2JobState assignment includes mediaState",
  fullAssignments.length >= 3 && fullAssignments.every((assignment) => /mediaState\s*:/.test(assignment)),
  `${fullAssignments.filter((assignment) => /mediaState\s*:/.test(assignment)).length}/${fullAssignments.length}`,
);

const unavailableBranch = shellSource.indexOf("<ExpiredPreviewView");
const desktopBranch = shellSource.indexOf("<PostPhase ");
const mobileBranch = shellSource.indexOf("<PostPhaseMobile ");
const exportedBranch = shellSource.indexOf("<ExportedView");
check(
  "shell branches unavailable done media before all player views",
  unavailableBranch >= 0 && unavailableBranch < desktopBranch && unavailableBranch < mobileBranch && unavailableBranch < exportedBranch,
);
check(
  "rerender CTA is bound to the safe confirmation-flow handler",
  hasSafeRerenderFlow(shellSource),
);
check(
  "rerender verifier rejects automatic submission appended to the handler",
  !hasSafeRerenderFlow(shellSource.replace("setStep(1);", "setStep(1); submit();")),
);
check(
  "rerender verifier rejects a CTA wired directly to submission",
  !hasSafeRerenderFlow(shellSource.replace(
    "onRerender={handlePreviewRerender}",
    "onRerender={() => void submit()}",
  )),
);

check("job hook centralizes defensive missing transition", /markMediaMissing/.test(jobSource) && /MEDIA_FILE_MISSING/.test(jobSource));
check("desktop preview videos have defensive onError wiring", (desktopSource.match(/onError=\{onMediaError\}/g) ?? []).length >= 2);
check("mobile preview videos have defensive onError wiring", (mobileSource.match(/onError=\{onMediaError\}/g) ?? []).length >= 2);
check("exported view video has defensive onError wiring", /function ExportedView[\s\S]*?<video[\s\S]*?onError=\{onMediaError\}/.test(shellSource));

if (failures > 0) {
  console.error(`\n${failures} expired-preview UI check(s) failed.`);
  process.exit(1);
}

console.log("\nAll expired-preview UI checks passed.");
}

void main();
