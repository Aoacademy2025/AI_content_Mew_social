import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectMediaState } from "../src/lib/media-retention";

const EXPIRED_COPY = "ไฟล์ Preview หมดอายุแล้วตามระยะเวลาของแพ็กเกจ กดสร้าง Preview ใหม่ได้";
const EXPIRED_CTA = "สร้าง Preview ใหม่";

function elements(node: ReactNode): ReactElement[] {
  if (!React.isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!React.isValidElement(node)) return React.Children.toArray(node).map(textContent).join("");
  return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
}

async function main() {
  const {
    ExpiredPreviewView,
    mediaStateFromJobPoll,
    prepareExpiredPreviewRerender,
    previewMediaStateAfterVideoError,
    shouldShowUnavailablePreview,
  } = await import("../src/app/(dashboard)/video-editor/_v2/ExpiredPreviewView");
  const { pollResponseIsCurrent } = await import("../src/app/(dashboard)/video-editor/_v2/useV2Job");

  const expired: ProjectMediaState = {
    status: "expired",
    expiredAt: "2026-07-10T00:00:00.000Z",
    canRerender: true,
  };
  let rerenders = 0;
  const expiredTree = ExpiredPreviewView({ state: expired, onRerender: () => { rerenders += 1; } });
  const expiredMarkup = renderToStaticMarkup(expiredTree);
  assert.match(expiredMarkup, new RegExp(EXPIRED_COPY));
  assert.match(expiredMarkup, new RegExp(EXPIRED_CTA));
  assert.doesNotMatch(expiredMarkup, /<video\b/i, "expired media never renders a video player");
  const rerenderButton = elements(expiredTree).find((element) =>
    typeof (element.props as { onClick?: unknown }).onClick === "function" && textContent(element) === EXPIRED_CTA,
  );
  assert.ok(rerenderButton, "expired view exposes the exact rerender CTA");
  (rerenderButton.props as { onClick?: () => void }).onClick?.();
  assert.equal(rerenders, 1, "rerender CTA invokes the provided callback exactly once");
  const preparationEvents: string[] = [];
  prepareExpiredPreviewRerender(
    () => preparationEvents.push("reset-job"),
    (step) => preparationEvents.push(`step-${step}`),
  );
  assert.deepEqual(
    preparationEvents,
    ["reset-job", "step-1"],
    "rerender returns to normal preparation without any render-submit capability",
  );

  const missing: ProjectMediaState = {
    status: "missing",
    canRerender: true,
    supportCode: "MEDIA_FILE_MISSING",
  };
  const available: ProjectMediaState = { status: "available", expiresAt: "2026-07-12T00:00:00.000Z" };
  const missingMarkup = renderToStaticMarkup(
    React.createElement(ExpiredPreviewView, { state: missing, onRerender: () => undefined }),
  );
  assert.match(missingMarkup, /ไม่พร้อมใช้งานโดยไม่คาดคิด/);
  assert.match(missingMarkup, /MEDIA_FILE_MISSING/);
  assert.match(missingMarkup, /ติดต่อทีม Support/);
  assert.doesNotMatch(missingMarkup, /หมดอายุแล้วตามระยะเวลาของแพ็กเกจ/);
  assert.doesNotMatch(missingMarkup, /<video\b/i, "missing media never renders a video player");

  const unknownMarkup = renderToStaticMarkup(
    React.createElement(ExpiredPreviewView, {
      state: { status: "missing", canRerender: true, supportCode: "MEDIA_EXPIRY_UNKNOWN" },
      onRerender: () => undefined,
    }),
  );
  assert.match(unknownMarkup, /ยังตรวจสอบสถานะไฟล์ Preview ไม่ได้/);
  assert.match(unknownMarkup, /MEDIA_EXPIRY_UNKNOWN/);
  assert.match(unknownMarkup, /ติดต่อทีม Support/);
  assert.doesNotMatch(unknownMarkup, /<video\b/i, "unknown legacy media never renders a player");

  assert.equal(shouldShowUnavailablePreview("done", expired), true);
  assert.equal(shouldShowUnavailablePreview("done", missing), true);
  assert.equal(shouldShowUnavailablePreview("done", null), true, "missing legacy API state fails closed");
  assert.equal(
    shouldShowUnavailablePreview("done", { status: "available", expiresAt: "2026-07-12T00:00:00.000Z" }),
    false,
  );
  assert.equal(shouldShowUnavailablePreview("rendering", missing), false);

  assert.equal(
    mediaStateFromJobPoll(missing, available),
    missing,
    "the newer job poll state wins over stale project detail",
  );
  assert.equal(
    mediaStateFromJobPoll(null, available),
    null,
    "an explicit fail-closed poll state is not replaced by stale project detail",
  );
  assert.equal(
    mediaStateFromJobPoll(undefined, available),
    available,
    "project detail is used only when an older poll response omits mediaState",
  );

  assert.deepEqual(
    previewMediaStateAfterVideoError(available),
    { status: "missing", canRerender: true, supportCode: "MEDIA_FILE_MISSING" },
    "a player failure after an available response becomes a missing incident",
  );
  assert.equal(
    previewMediaStateAfterVideoError(expired),
    expired,
    "a late video error must not overwrite an already-expired state",
  );
  assert.equal(
    previewMediaStateAfterVideoError(missing),
    missing,
    "repeated video errors preserve the newest unavailable state",
  );

  const currentPoll = {
    responseGeneration: 4,
    currentGeneration: 4,
    responseJobId: "job-new",
    currentJobId: "job-new",
    responseRequestId: 12,
    lastAppliedRequestId: 11,
  };
  assert.equal(pollResponseIsCurrent(currentPoll), true, "the next response in the active poll generation is accepted");
  assert.equal(
    pollResponseIsCurrent({ ...currentPoll, responseGeneration: 3 }),
    false,
    "a response started before video onError invalidated polling cannot overwrite the missing incident",
  );
  assert.equal(
    pollResponseIsCurrent({ ...currentPoll, responseJobId: "job-old" }),
    false,
    "a response for a previous job cannot overwrite the active job",
  );
  assert.equal(
    pollResponseIsCurrent({ ...currentPoll, responseRequestId: 10 }),
    false,
    "an out-of-order response cannot overwrite a newer response",
  );
  let incidentState: ProjectMediaState = available;
  let activeGeneration = 4;
  const inFlightGeneration = activeGeneration;
  incidentState = previewMediaStateAfterVideoError(incidentState);
  activeGeneration += 1;
  if (pollResponseIsCurrent({
    ...currentPoll,
    responseGeneration: inFlightGeneration,
    currentGeneration: activeGeneration,
  })) {
    incidentState = available;
  }
  assert.deepEqual(
    incidentState,
    { status: "missing", canRerender: true, supportCode: "MEDIA_FILE_MISSING" },
    "a stale available response cannot undo a defensive video-error transition",
  );

  for (const filename of ["PostPhase.tsx", "PostPhaseMobile.tsx"]) {
    const source = readFileSync(
      new URL(`../src/app/(dashboard)/video-editor/_v2/${filename}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /onPreviewError/);
    assert.match(source, /onError=\{onPreviewError\}/);
  }

  console.log("PASS expired preview UI");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
