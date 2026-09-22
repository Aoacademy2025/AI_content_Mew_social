import assert from "node:assert/strict";

import {
  activateEditorDiagnostics,
  createEditorDiagnosticSnapshot,
  EDITOR_DIAGNOSTICS_CONTEXT_KEY,
  updateEditorDiagnosticSnapshot,
} from "../src/lib/editor-diagnostics";
import { beforeSendSentryEvent } from "../src/lib/sentry-config";

const forbiddenCanary = "PRIVATE_SCRIPT_CANARY_DO_NOT_SEND";
const forbiddenUrl = "https://media.example/private/customer-video.mp4";

function depthEvent() {
  return {
    event_id: "synthetic-depth-event",
    release: "hero-test-release",
    exception: {
      values: [{
        type: "Error",
        value: "Maximum update depth exceeded. This can happen when a component repeatedly calls setState.",
      }],
    },
  };
}

function main() {
  const snapshot = createEditorDiagnosticSnapshot();
  updateEditorDiagnosticSnapshot(snapshot, {
    phase: "not-a-phase",
    lifecycle: "ready",
    recoveryValidity: "valid",
    recoveryVersion: "v1",
    revisionRelation: "newer",
    saveState: "saved",
    inputType: "insertSecretCustomerText",
    composing: true,
    focusTarget: "not-a-target",
  });
  Object.assign(snapshot, {
    script: forbiddenCanary,
    transcript: forbiddenCanary,
    clipboard: forbiddenCanary,
    html: `<div>${forbiddenCanary}</div>`,
    selector: `#${forbiddenCanary}`,
    projectId: forbiddenCanary,
    accountId: forbiddenCanary,
    jobId: forbiddenCanary,
    mediaUrl: forbiddenUrl,
    arbitrary: { localStorage: forbiddenCanary },
    rawError: new Error(forbiddenCanary),
  });

  const deactivate = activateEditorDiagnostics(snapshot);
  const unrelated = beforeSendSentryEvent({
    message: "ordinary editor error",
    contexts: {
      [EDITOR_DIAGNOSTICS_CONTEXT_KEY]: {
        script: forbiddenCanary,
        mediaUrl: forbiddenUrl,
      },
    },
  });
  assert(unrelated, "unrelated application errors remain reportable");
  assert.equal(
    unrelated.contexts?.[EDITOR_DIAGNOSTICS_CONTEXT_KEY],
    undefined,
    "unrelated errors never receive editor diagnostics",
  );

  const sent = beforeSendSentryEvent(depthEvent());
  assert(sent, "the existing depth exception remains reportable");
  assert.equal(sent.release, "hero-test-release", "the existing release stays on the event");
  assert.deepEqual(sent.contexts?.[EDITOR_DIAGNOSTICS_CONTEXT_KEY], {
    phase: "unknown",
    lifecycle: "ready",
    recovery_validity: "valid",
    recovery_version: "v1",
    revision_relation: "newer",
    save_state: "saved",
    input_type: "other",
    composing: true,
    focus_target: "other",
    mount_count: 1,
  });
  const envelope = JSON.stringify(sent);
  assert.doesNotMatch(envelope, new RegExp(forbiddenCanary));
  assert.doesNotMatch(envelope, /customer-video\.mp4/);

  const bounded = beforeSendSentryEvent(depthEvent());
  assert(bounded, "a repeated existing exception is not dropped");
  assert.equal(
    bounded.contexts?.[EDITOR_DIAGNOSTICS_CONTEXT_KEY],
    undefined,
    "diagnostics attach at most once per editor mount",
  );

  deactivate();

  const secondSnapshot = createEditorDiagnosticSnapshot();
  updateEditorDiagnosticSnapshot(secondSnapshot, {
    phase: "post",
    lifecycle: "ready",
    recoveryValidity: "none",
    recoveryVersion: "none",
    revisionRelation: "unknown",
    saveState: "idle",
    inputType: "none",
    composing: false,
    focusTarget: "none",
  });
  const deactivateSecond = activateEditorDiagnostics(secondSnapshot);
  deactivate();
  const remounted = beforeSendSentryEvent(depthEvent());
  assert(remounted, "a remounted editor keeps the existing exception reportable");
  assert.deepEqual(remounted.contexts?.[EDITOR_DIAGNOSTICS_CONTEXT_KEY], {
    phase: "post",
    lifecycle: "ready",
    recovery_validity: "none",
    recovery_version: "none",
    revision_relation: "unknown",
    save_state: "idle",
    input_type: "none",
    composing: false,
    focus_target: "none",
    mount_count: 2,
  }, "a stale cleanup cannot clear or reuse another mount's snapshot");
  deactivateSecond();

  const unmounted = beforeSendSentryEvent(depthEvent());
  assert(unmounted, "the existing exception is still reportable after unmount");
  assert.equal(
    unmounted.contexts?.[EDITOR_DIAGNOSTICS_CONTEXT_KEY],
    undefined,
    "an unmounted editor leaves no diagnostic context",
  );

  console.log("editor-diagnostics-privacy: final envelope allowlist passed");
}

main();
