export const EDITOR_PROJECT_SAVE_TIMEOUT_MS = 10_000;
const MAX_DRAFT_REVISION = 2_147_483_647;

export type EditorProjectSaveStatus = "saving" | "saved" | "error";

export type EditorProjectSaveEvent = {
  projectId: string;
  revision: number;
  status: EditorProjectSaveStatus;
};

export type EditorProjectSaveContext = {
  revision: number;
  signal: AbortSignal;
};

type SaveRequest = {
  projectId: string;
  save: (context: EditorProjectSaveContext) => Promise<boolean>;
  isActive: () => boolean;
  onStatus?: (event: EditorProjectSaveEvent) => void;
  revision: number;
};

type SaveLane = {
  projectId: string;
  running: boolean;
  pending: SaveRequest | null;
  latestRevision: number;
  idleWaiters: Array<() => void>;
};

export type EditorProjectSaveInput = {
  projectId: string;
  save: (context: EditorProjectSaveContext) => Promise<boolean>;
  isActive?: () => boolean;
  onStatus?: (event: EditorProjectSaveEvent) => void;
};

type SaveQueueOptions = {
  requestTimeoutMs?: number;
  scheduleTimeout?: (task: () => void, delayMs: number) => unknown;
  cancelTimeout?: (token: unknown) => void;
};

export function createEditorProjectSaveQueue(options: SaveQueueOptions = {}) {
  const lanes = new Map<string, SaveLane>();
  const revisionWatermarks = new Map<string, number>();
  const requestTimeoutMs = options.requestTimeoutMs ?? EDITOR_PROJECT_SAVE_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout
    ?? ((task: () => void, delayMs: number) => setTimeout(task, delayMs));
  const cancelTimeout = options.cancelTimeout
    ?? ((token: unknown) => clearTimeout(token as ReturnType<typeof setTimeout>));

  function normalizedProjectId(projectId: string): string {
    const normalized = projectId.trim();
    if (!normalized) throw new Error("projectId is required");
    return normalized;
  }

  function seedRevision(projectId: string, revision: number): void {
    const normalized = normalizedProjectId(projectId);
    if (!Number.isInteger(revision) || revision < 0 || revision > MAX_DRAFT_REVISION) return;
    revisionWatermarks.set(
      normalized,
      Math.max(revisionWatermarks.get(normalized) ?? 0, revision),
    );
  }

  function nextRevision(projectId: string): number {
    const current = revisionWatermarks.get(projectId) ?? 0;
    if (current >= MAX_DRAFT_REVISION) throw new Error("draft revision exhausted");
    const revision = current + 1;
    revisionWatermarks.set(projectId, revision);
    return revision;
  }

  function revisionWatermark(projectId: string): number {
    return revisionWatermarks.get(normalizedProjectId(projectId)) ?? 0;
  }

  function laneFor(projectId: string): SaveLane {
    const existing = lanes.get(projectId);
    if (existing) return existing;
    const lane: SaveLane = {
      projectId,
      running: false,
      pending: null,
      latestRevision: revisionWatermarks.get(projectId) ?? 0,
      idleWaiters: [],
    };
    lanes.set(projectId, lane);
    return lane;
  }

  function publish(request: SaveRequest, status: EditorProjectSaveStatus): void {
    if (!request.onStatus || !request.isActive()) return;
    try {
      request.onStatus({
        projectId: request.projectId,
        revision: request.revision,
        status,
      });
    } catch {
      // Presentation callbacks cannot affect persistence ordering.
    }
  }

  async function runWithTimeout(request: SaveRequest): Promise<boolean> {
    const controller = new AbortController();
    let timeoutToken: unknown;
    let rawSaveResult: Promise<boolean>;
    try {
      rawSaveResult = request.save({ revision: request.revision, signal: controller.signal });
    } catch {
      rawSaveResult = Promise.resolve(false);
    }
    const saveResult = rawSaveResult.then((ok) => ok === true, () => false);
    const timeoutResult = new Promise<boolean>((resolve) => {
      timeoutToken = scheduleTimeout(() => {
        controller.abort();
        resolve(false);
      }, requestTimeoutMs);
    });
    const ok = await Promise.race([saveResult, timeoutResult]);
    if (timeoutToken !== undefined) cancelTimeout(timeoutToken);
    return ok;
  }

  function releaseIdleLane(lane: SaveLane): void {
    if (lane.running || lane.pending) return;
    const waiters = lane.idleWaiters.splice(0);
    if (lanes.get(lane.projectId) === lane) lanes.delete(lane.projectId);
    for (const resolve of waiters) resolve();
  }

  async function drain(lane: SaveLane): Promise<void> {
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.pending) {
        const request = lane.pending;
        lane.pending = null;
        let ok = false;
        try {
          ok = await runWithTimeout(request);
        } catch {
          ok = false;
        }
        if (lane.latestRevision === request.revision && !lane.pending) {
          publish(request, ok ? "saved" : "error");
        }
      }
    } finally {
      lane.running = false;
      releaseIdleLane(lane);
    }
  }

  function enqueue(input: EditorProjectSaveInput): number {
    const projectId = normalizedProjectId(input.projectId);
    const revision = nextRevision(projectId);
    const lane = laneFor(projectId);
    const request: SaveRequest = {
      projectId,
      save: input.save,
      isActive: input.isActive ?? (() => true),
      onStatus: input.onStatus,
      revision,
    };
    lane.latestRevision = revision;
    lane.pending = request;
    publish(request, "saving");
    void drain(lane);
    return revision;
  }

  function whenIdle(projectId: string): Promise<void> {
    const lane = lanes.get(projectId.trim());
    if (!lane || (!lane.running && !lane.pending)) return Promise.resolve();
    return new Promise((resolve) => lane.idleWaiters.push(resolve));
  }

  function laneCount(): number {
    return lanes.size;
  }

  return { seedRevision, revisionWatermark, enqueue, whenIdle, laneCount };
}

export const editorProjectSaveQueue = createEditorProjectSaveQueue();
