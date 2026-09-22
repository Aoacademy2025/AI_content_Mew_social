import type { ErrorEvent } from "@sentry/nextjs";

export const EDITOR_DIAGNOSTICS_CONTEXT_KEY = "editor_diagnostics";

export type EditorDiagnosticSnapshot = {
  phase: unknown;
  lifecycle: unknown;
  recoveryValidity: unknown;
  recoveryVersion: unknown;
  revisionRelation: unknown;
  saveState: unknown;
  inputType: unknown;
  composing: unknown;
  focusTarget: unknown;
  mountCount: unknown;
};

export type EditorDiagnosticContext = {
  phase: "setup" | "rendering" | "post" | "unknown";
  lifecycle: "new" | "loading" | "ready" | "recovery-conflict" | "unknown";
  recovery_validity: "none" | "valid" | "invalid" | "unknown";
  recovery_version: "none" | "v1" | "unknown";
  revision_relation: "same" | "older" | "newer" | "unknown";
  save_state: "idle" | "saving" | "saved" | "error" | "unknown";
  input_type:
    | "none"
    | "insertText"
    | "insertCompositionText"
    | "insertFromPaste"
    | "insertFromDrop"
    | "insertLineBreak"
    | "insertParagraph"
    | "deleteContentBackward"
    | "deleteContentForward"
    | "deleteByCut"
    | "historyUndo"
    | "historyRedo"
    | "other";
  composing: boolean;
  focus_target: "none" | "script" | "project-title" | "dialog" | "control" | "media" | "other";
  mount_count: number;
};

type ActiveEditorDiagnostics = {
  owner: symbol;
  snapshot: EditorDiagnosticSnapshot;
  remainingAttachments: number;
};

let activeEditorDiagnostics: ActiveEditorDiagnostics | null = null;
let editorMountCount = 0;

const PHASES = ["setup", "rendering", "post", "unknown"] as const;
const LIFECYCLES = ["new", "loading", "ready", "recovery-conflict", "unknown"] as const;
const RECOVERY_VALIDITIES = ["none", "valid", "invalid", "unknown"] as const;
const RECOVERY_VERSIONS = ["none", "v1", "unknown"] as const;
const REVISION_RELATIONS = ["same", "older", "newer", "unknown"] as const;
const SAVE_STATES = ["idle", "saving", "saved", "error", "unknown"] as const;
const INPUT_TYPES = [
  "none",
  "insertText",
  "insertCompositionText",
  "insertFromPaste",
  "insertFromDrop",
  "insertLineBreak",
  "insertParagraph",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteByCut",
  "historyUndo",
  "historyRedo",
  "other",
] as const;
const FOCUS_TARGETS = ["none", "script", "project-title", "dialog", "control", "media", "other"] as const;

function fixedEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function errorText(event: ErrorEvent): string {
  return [
    event.message,
    ...(event.exception?.values ?? []).map((exception) => exception.value),
  ]
    .filter(Boolean)
    .join("\n");
}

export function isReactMaximumUpdateDepthEvent(event: ErrorEvent): boolean {
  return /Maximum update depth exceeded|Minified React error #185\b|react\.dev\/errors\/185\b/i.test(
    errorText(event),
  );
}

function allowlistedContext(snapshot: EditorDiagnosticSnapshot): EditorDiagnosticContext {
  const mountCount = typeof snapshot.mountCount === "number" && Number.isFinite(snapshot.mountCount)
    ? Math.trunc(snapshot.mountCount)
    : 1;
  return {
    phase: fixedEnum(snapshot.phase, PHASES, "unknown"),
    lifecycle: fixedEnum(snapshot.lifecycle, LIFECYCLES, "unknown"),
    recovery_validity: fixedEnum(snapshot.recoveryValidity, RECOVERY_VALIDITIES, "unknown"),
    recovery_version: fixedEnum(snapshot.recoveryVersion, RECOVERY_VERSIONS, "unknown"),
    revision_relation: fixedEnum(snapshot.revisionRelation, REVISION_RELATIONS, "unknown"),
    save_state: fixedEnum(snapshot.saveState, SAVE_STATES, "unknown"),
    input_type: fixedEnum(snapshot.inputType, INPUT_TYPES, "other"),
    composing: snapshot.composing === true,
    focus_target: fixedEnum(snapshot.focusTarget, FOCUS_TARGETS, "other"),
    mount_count: Math.max(1, Math.min(10, mountCount)),
  };
}

export function createEditorDiagnosticSnapshot(): EditorDiagnosticSnapshot {
  return {
    phase: "unknown",
    lifecycle: "unknown",
    recoveryValidity: "unknown",
    recoveryVersion: "unknown",
    revisionRelation: "unknown",
    saveState: "unknown",
    inputType: "none",
    composing: false,
    focusTarget: "none",
    mountCount: 0,
  };
}

export function updateEditorDiagnosticSnapshot(
  snapshot: EditorDiagnosticSnapshot,
  next: Partial<EditorDiagnosticSnapshot>,
): void {
  Object.assign(snapshot, next);
}

export function activateEditorDiagnostics(
  snapshot: EditorDiagnosticSnapshot,
): () => void {
  const owner = Symbol("editor-diagnostics-mount");
  editorMountCount = Math.min(10, editorMountCount + 1);
  snapshot.mountCount = editorMountCount;
  activeEditorDiagnostics = { owner, snapshot, remainingAttachments: 1 };

  return () => {
    if (activeEditorDiagnostics?.owner !== owner) return;
    activeEditorDiagnostics = null;
  };
}

export function consumeEditorDiagnostics(
  event: ErrorEvent,
): EditorDiagnosticContext | null {
  const active = activeEditorDiagnostics;
  if (
    !active
    || active.remainingAttachments < 1
    || !isReactMaximumUpdateDepthEvent(event)
  ) return null;

  active.remainingAttachments -= 1;
  return allowlistedContext(active.snapshot);
}
