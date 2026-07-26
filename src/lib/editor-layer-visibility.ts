export type EditorLayerVisibility = {
  avatar: boolean;
  subtitles: boolean;
};

export type EditableEditorLayer = keyof EditorLayerVisibility | "logo";

export const DEFAULT_EDITOR_LAYER_VISIBILITY: EditorLayerVisibility = {
  avatar: true,
  subtitles: true,
};

export function normalizeEditorLayerVisibility(value: unknown): EditorLayerVisibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_EDITOR_LAYER_VISIBILITY };
  }
  const candidate = value as Record<string, unknown>;
  return {
    avatar: typeof candidate.avatar === "boolean"
      ? candidate.avatar
      : DEFAULT_EDITOR_LAYER_VISIBILITY.avatar,
    subtitles: typeof candidate.subtitles === "boolean"
      ? candidate.subtitles
      : DEFAULT_EDITOR_LAYER_VISIBILITY.subtitles,
  };
}

export function canToggleAvatarLayer(input: {
  hasAvatar: boolean;
  avatarBaseVideoUrl: string | null | undefined;
}): boolean {
  return input.hasAvatar && Boolean(input.avatarBaseVideoUrl);
}

export function resolveEditorPreviewVideoUrl(input: {
  renderedVideoUrl: string;
  avatarBaseVideoUrl: string | null | undefined;
  avatarVisible: boolean;
}): string {
  if (!input.avatarVisible && input.avatarBaseVideoUrl) {
    return input.avatarBaseVideoUrl;
  }
  return input.renderedVideoUrl;
}
