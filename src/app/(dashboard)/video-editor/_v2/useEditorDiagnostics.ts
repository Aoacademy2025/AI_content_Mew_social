"use client";

import {
  useEffect,
  useRef,
  type CompositionEventHandler,
  type FocusEventHandler,
  type FormEventHandler,
} from "react";
import {
  activateEditorDiagnostics,
  createEditorDiagnosticSnapshot,
  updateEditorDiagnosticSnapshot,
} from "@/lib/editor-diagnostics";

export type EditorDiagnosticsInput = {
  phase: unknown;
  lifecycle: unknown;
  recoveryValidity: unknown;
  recoveryVersion: unknown;
  revisionRelation: unknown;
  saveState: unknown;
};

export type EditorDiagnosticEventHandlers = {
  onInputCapture?: FormEventHandler<HTMLElement>;
  onCompositionStartCapture?: CompositionEventHandler<HTMLElement>;
  onCompositionEndCapture?: CompositionEventHandler<HTMLElement>;
  onFocusCapture?: FocusEventHandler<HTMLElement>;
  onBlurCapture?: FocusEventHandler<HTMLElement>;
};

function focusTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "other";
  const tag = target.tagName.toLowerCase();
  if (tag === "textarea") return "script";
  if (target.closest('[role="dialog"], [role="alertdialog"]')) return "dialog";
  if (tag === "input") {
    return (target as HTMLInputElement).type === "text" ? "project-title" : "control";
  }
  if (tag === "button" || tag === "select") return "control";
  if (tag === "audio" || tag === "video") return "media";
  return "other";
}

export function useEditorDiagnostics(
  input: EditorDiagnosticsInput,
): EditorDiagnosticEventHandlers {
  const snapshotRef = useRef(createEditorDiagnosticSnapshot());
  // The snapshot is observed only by Sentry's capture path. Mutating it cannot
  // schedule React work or enter the editor's autosave dependencies.
  // eslint-disable-next-line react-hooks/refs
  updateEditorDiagnosticSnapshot(snapshotRef.current, input);

  useEffect(() => activateEditorDiagnostics(snapshotRef.current), []);

  return {
    onInputCapture: (event) => {
      const nativeEvent = event.nativeEvent as InputEvent;
      updateEditorDiagnosticSnapshot(snapshotRef.current, {
        inputType: nativeEvent.inputType,
        composing: nativeEvent.isComposing,
      });
    },
    onCompositionStartCapture: () => {
      updateEditorDiagnosticSnapshot(snapshotRef.current, { composing: true });
    },
    onCompositionEndCapture: () => {
      updateEditorDiagnosticSnapshot(snapshotRef.current, { composing: false });
    },
    onFocusCapture: (event) => {
      updateEditorDiagnosticSnapshot(snapshotRef.current, {
        focusTarget: focusTarget(event.target),
      });
    },
    onBlurCapture: (event) => {
      updateEditorDiagnosticSnapshot(snapshotRef.current, {
        focusTarget: event.relatedTarget ? focusTarget(event.relatedTarget) : "none",
      });
    },
  };
}
