export type EditorProjectBootstrapProject = {
  id: string;
  draftRevision: number;
  draft?: unknown;
  [key: string]: unknown;
};

export type EditorProjectBootstrapOutcome =
  | { kind: "server"; project: EditorProjectBootstrapProject }
  | {
      kind: "local";
      project: EditorProjectBootstrapProject;
      draft: Record<string, unknown>;
    }
  | { kind: "error"; recoveryDraft: Record<string, unknown> | null }
  | { kind: "missing" };

export function isEditorProjectRecoveryDraft(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

export async function resolveEditorProjectBootstrap(input: {
  projectId: string;
  localDraft?: unknown;
  localDirty?: boolean;
  readLocalDraft?: () => unknown;
  isLocalDirty?: () => boolean;
  revisionWatermark: number;
  loadProject: () => Promise<{ status: number; project?: unknown }>;
}): Promise<EditorProjectBootstrapOutcome> {
  const readRecoveryDraft = () => {
    const value = input.readLocalDraft ? input.readLocalDraft() : input.localDraft;
    return isEditorProjectRecoveryDraft(value) ? value : null;
  };
  let response: { status: number; project?: unknown };
  try {
    response = await input.loadProject();
  } catch {
    return { kind: "error", recoveryDraft: readRecoveryDraft() };
  }
  const recoveryDraft = readRecoveryDraft();
  if (response.status === 404) return { kind: "missing" };
  if (response.status < 200 || response.status >= 300) {
    return { kind: "error", recoveryDraft };
  }

  const value = response.project;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "error", recoveryDraft };
  }
  const project = value as EditorProjectBootstrapProject;
  if (
    project.id !== input.projectId
    || !Number.isInteger(project.draftRevision)
    || project.draftRevision < 0
  ) {
    return { kind: "error", recoveryDraft };
  }

  const localDirty = input.isLocalDirty ? input.isLocalDirty() : input.localDirty === true;
  if (project.draftRevision < input.revisionWatermark || localDirty) {
    return recoveryDraft
      ? { kind: "local", project, draft: recoveryDraft }
      : { kind: "error", recoveryDraft: null };
  }
  return { kind: "server", project };
}
