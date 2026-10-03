"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { normalizeWebPendingEdit, type WebPendingEdit } from "./pending-edit-view";

/**
 * T8 (ADR 0064, G21): standalone, narrowly-scoped load of the project's Pending Edit Draft.
 *
 * Deliberately independent of `useV2Project.ts`'s bootstrap/autosave machinery:
 * `applyServerProjectMetadata` there is called from many PATCH/create response paths that don't
 * carry a `pendingEdit` field, so wiring this state into it risks silently clearing the banner
 * after an unrelated project edit. This hook owns its own minimal `GET /api/editor-projects/:id`
 * fetch instead, re-run whenever the project or its active base job changes.
 */
export function usePendingEditDraft(
  projectId: string | null | undefined,
  activeJobId: string | null | undefined,
): { pendingEdit: WebPendingEdit | null; reloadPendingEdit: () => Promise<WebPendingEdit | null> } {
  const [pendingEdit, setPendingEdit] = useState<WebPendingEdit | null>(null);
  const requestRef = useRef(0);

  const reloadPendingEdit = useCallback(async (): Promise<WebPendingEdit | null> => {
    if (!projectId) {
      setPendingEdit(null);
      return null;
    }
    const requestId = (requestRef.current += 1);
    try {
      const res = await authenticatedFetch(`/api/editor-projects/${projectId}`, { cache: "no-store" });
      if (!res.ok) return null;
      const d = await res.json().catch(() => null);
      const next = normalizeWebPendingEdit((d as { project?: { pendingEdit?: unknown } } | null)?.project?.pendingEdit);
      // Drop a stale response that resolved after a newer request already started.
      if (requestRef.current === requestId) setPendingEdit(next);
      return next;
    } catch {
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    void reloadPendingEdit();
  }, [reloadPendingEdit, activeJobId]);

  return { pendingEdit, reloadPendingEdit };
}
