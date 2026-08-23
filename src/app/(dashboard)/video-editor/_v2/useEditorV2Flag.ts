/**
 * Editor v2 is the current product. An explicit build-time `0` is the only
 * emergency rollback; old localStorage/query overrides are intentionally
 * ignored so a browser cannot remain pinned to the retired editor.
 */
const V2_DEFAULT = process.env.NEXT_PUBLIC_EDITOR_V2 !== "0";

export function useEditorV2(): boolean {
  return V2_DEFAULT;
}
