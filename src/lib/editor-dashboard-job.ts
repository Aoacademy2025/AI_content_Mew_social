export type DashboardEditorProject = {
  id: string;
  status: string;
  activeJobId?: string | null;
  activeExportJobId?: string | null;
};

export type DashboardEditorJobPointer = {
  projectId: string | null;
  jobId: string;
};

type ReadableStorage = Pick<Storage, "getItem">;
type ProjectListResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

const PROJECT_ID_KEY = "editor-v2-project-id";
const PROJECT_ACCOUNT_KEY = "editor-v2-project-account";
const JOB_ID_KEY = "editor-v2-job";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pointerFor(project: DashboardEditorProject): DashboardEditorJobPointer | null {
  if (project.status === "archived") return null;
  const jobId = project.status === "exporting"
    ? nonEmpty(project.activeExportJobId)
    : project.status === "rendering"
      ? nonEmpty(project.activeJobId)
      : nonEmpty(project.activeExportJobId) ?? nonEmpty(project.activeJobId);
  return jobId ? { projectId: project.id, jobId } : null;
}

export function selectDashboardEditorJobPointer(
  projects: readonly DashboardEditorProject[],
): DashboardEditorJobPointer | null {
  for (const project of projects) {
    if (project.status !== "rendering" && project.status !== "exporting") continue;
    const pointer = pointerFor(project);
    if (pointer) return pointer;
  }
  for (const project of projects) {
    const pointer = pointerFor(project);
    if (pointer) return pointer;
  }
  return null;
}

export function readProjectScopedEditorJobPointer(
  storage: ReadableStorage,
): DashboardEditorJobPointer | null {
  const accountId = nonEmpty(storage.getItem(PROJECT_ACCOUNT_KEY));
  const projectId = nonEmpty(storage.getItem(
    accountId ? `${PROJECT_ID_KEY}:${accountId}` : PROJECT_ID_KEY,
  )) ?? nonEmpty(storage.getItem(PROJECT_ID_KEY));
  if (!projectId) return null;
  const jobId = nonEmpty(storage.getItem(`${JOB_ID_KEY}:${projectId}`))
    ?? nonEmpty(storage.getItem(JOB_ID_KEY));
  return jobId ? { projectId, jobId } : null;
}

export function editorDashboardJobHref(
  pointer: DashboardEditorJobPointer | null,
): string {
  const params = new URLSearchParams({ ui: "v2" });
  if (pointer?.projectId) params.set("projectId", pointer.projectId);
  return `/video-editor?${params.toString()}`;
}

export async function resolveDashboardEditorJobPointer(input: {
  fetchProjects(): Promise<ProjectListResponse>;
  storage?: ReadableStorage | null;
}): Promise<DashboardEditorJobPointer | null> {
  try {
    const response = await input.fetchProjects();
    if (response.ok) {
      const body = await response.json() as { projects?: unknown };
      if (Array.isArray(body.projects)) {
        const pointer = selectDashboardEditorJobPointer(
          body.projects.filter((project): project is DashboardEditorProject => (
            !!project
            && typeof project === "object"
            && nonEmpty((project as DashboardEditorProject).id) !== null
            && typeof (project as DashboardEditorProject).status === "string"
          )),
        );
        if (pointer) return pointer;
      }
    }
  } catch {
    // Dashboard status is supplementary. A rolling-deploy browser fallback keeps
    // the link usable while the project list is temporarily unavailable.
  }
  try {
    return input.storage ? readProjectScopedEditorJobPointer(input.storage) : null;
  } catch {
    return null;
  }
}
