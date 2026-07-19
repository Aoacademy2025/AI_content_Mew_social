import type { EditorDraft } from "./types";

export const DRAFT_KEY = "ve_drafts_v2";

function browserStorage() {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === "function" ? storage : null;
}

export function loadDrafts(): EditorDraft[] {
  try { return JSON.parse(browserStorage()?.getItem(DRAFT_KEY) ?? "[]"); } catch { return []; }
}

export function saveDrafts(drafts: EditorDraft[]) {
  try { browserStorage()?.setItem(DRAFT_KEY, JSON.stringify(drafts.slice(0, 20))); } catch {}
}

export function newDraftId(): string {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
