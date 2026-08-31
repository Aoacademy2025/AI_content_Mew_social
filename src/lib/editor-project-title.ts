export const DEFAULT_EDITOR_PROJECT_TITLE = "New Project";
export const MAX_EDITOR_PROJECT_TITLE_LENGTH = 80;

export type EditorProjectRenameValidation =
  | { ok: true; title: string }
  | { ok: false; message: string };

export function sanitizeEditorProjectTitle(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const title = raw || DEFAULT_EDITOR_PROJECT_TITLE;
  return title.slice(0, MAX_EDITOR_PROJECT_TITLE_LENGTH);
}

export function validateEditorProjectRename(value: unknown): EditorProjectRenameValidation {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title) return { ok: false, message: "กรุณาใส่ชื่อโปรเจกต์" };
  if (title.length > MAX_EDITOR_PROJECT_TITLE_LENGTH) {
    return {
      ok: false,
      message: `ชื่อโปรเจกต์ยาวได้ไม่เกิน ${MAX_EDITOR_PROJECT_TITLE_LENGTH} ตัวอักษร`,
    };
  }
  return { ok: true, title };
}
