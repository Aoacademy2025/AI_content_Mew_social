export type EditorProjectSaveStatus = "saving" | "saved" | "error";

export type EditorProjectSaveEvent = {
  projectId: string;
  revision: number;
  status: EditorProjectSaveStatus;
};

type SaveRequest<Draft> = {
  projectId: string;
  draft: Draft;
  save: (projectId: string, draft: Draft) => Promise<boolean>;
  isActive: () => boolean;
  onStatus?: (event: EditorProjectSaveEvent) => void;
  revision: number;
};

type SaveLane<Draft> = {
  running: boolean;
  pending: SaveRequest<Draft> | null;
  latest: SaveRequest<Draft> | null;
  idleWaiters: Array<() => void>;
};

export type EditorProjectSaveInput<Draft> = {
  projectId: string;
  draft: Draft;
  save: (projectId: string, draft: Draft) => Promise<boolean>;
  isActive?: () => boolean;
  onStatus?: (event: EditorProjectSaveEvent) => void;
};

type RetryObserver = {
  isActive?: () => boolean;
  onStatus?: (event: EditorProjectSaveEvent) => void;
};

export function createEditorProjectSaveQueue<Draft>() {
  const lanes = new Map<string, SaveLane<Draft>>();
  let nextRevision = 0;

  function laneFor(projectId: string): SaveLane<Draft> {
    const existing = lanes.get(projectId);
    if (existing) return existing;
    const lane: SaveLane<Draft> = {
      running: false,
      pending: null,
      latest: null,
      idleWaiters: [],
    };
    lanes.set(projectId, lane);
    return lane;
  }

  function publish(request: SaveRequest<Draft>, status: EditorProjectSaveStatus): void {
    if (!request.onStatus || !request.isActive()) return;
    try {
      request.onStatus({
        projectId: request.projectId,
        revision: request.revision,
        status,
      });
    } catch {
      // Save ordering must not depend on a presentation callback.
    }
  }

  function resolveIdle(lane: SaveLane<Draft>): void {
    if (lane.running || lane.pending) return;
    const waiters = lane.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async function drain(lane: SaveLane<Draft>): Promise<void> {
    if (lane.running) return;
    lane.running = true;
    while (lane.pending) {
      const request = lane.pending;
      lane.pending = null;
      let ok = false;
      try {
        ok = await request.save(request.projectId, request.draft);
      } catch {
        ok = false;
      }
      if (lane.latest?.revision === request.revision && !lane.pending) {
        publish(request, ok ? "saved" : "error");
      }
    }
    lane.running = false;
    resolveIdle(lane);
  }

  function enqueue(input: EditorProjectSaveInput<Draft>): number {
    const projectId = input.projectId.trim();
    if (!projectId) throw new Error("projectId is required");
    const lane = laneFor(projectId);
    const request: SaveRequest<Draft> = {
      projectId,
      draft: input.draft,
      save: input.save,
      isActive: input.isActive ?? (() => true),
      onStatus: input.onStatus,
      revision: ++nextRevision,
    };
    lane.latest = request;
    lane.pending = request;
    publish(request, "saving");
    void drain(lane);
    return request.revision;
  }

  function retry(projectId: string, observer: RetryObserver = {}): number | null {
    const latest = lanes.get(projectId.trim())?.latest;
    if (!latest) return null;
    return enqueue({
      projectId: latest.projectId,
      draft: latest.draft,
      save: latest.save,
      isActive: observer.isActive ?? latest.isActive,
      onStatus: observer.onStatus ?? latest.onStatus,
    });
  }

  function whenIdle(projectId: string): Promise<void> {
    const lane = lanes.get(projectId.trim());
    if (!lane || (!lane.running && !lane.pending)) return Promise.resolve();
    return new Promise((resolve) => lane.idleWaiters.push(resolve));
  }

  return { enqueue, retry, whenIdle };
}
