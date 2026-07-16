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

export type EditorProjectSaveOutcome =
  | { kind: "saved" }
  | { kind: "error" }
  | { kind: "ambiguous" }
  | { kind: "blocked" };

type SaveRequest = {
  projectId: string;
  save: (context: EditorProjectSaveContext) => Promise<boolean | EditorProjectSaveOutcome>;
  reconcile?: (context: EditorProjectSaveContext) => Promise<EditorProjectSaveOutcome>;
  onBlocked?: (event: EditorProjectSaveEvent) => void;
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
  save: (context: EditorProjectSaveContext) => Promise<boolean | EditorProjectSaveOutcome>;
  reconcile?: (context: EditorProjectSaveContext) => Promise<EditorProjectSaveOutcome>;
  onBlocked?: (event: EditorProjectSaveEvent) => void;
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

  function normalizeOutcome(
    value: unknown,
    allowLegacyBoolean: boolean,
  ): EditorProjectSaveOutcome {
    if (allowLegacyBoolean && value === true) return { kind: "saved" };
    if (allowLegacyBoolean && value === false) return { kind: "error" };
    if (value === null || typeof value !== "object") return { kind: "error" };
    try {
      if (Array.isArray(value)) return { kind: "error" };
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return { kind: "error" };
      const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return { kind: "error" };
      }
      switch (descriptor.value) {
        case "saved":
        case "error":
        case "ambiguous":
        case "blocked":
          return { kind: descriptor.value };
        default:
          return { kind: "error" };
      }
    } catch {
      return { kind: "error" };
    }
  }

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

  function reserveRevisionAbove(projectId: string, observed: number): number {
    seedRevision(projectId, observed);
    return nextRevision(normalizedProjectId(projectId));
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

  async function runBoundedPhase(
    revision: number,
    phase: (context: EditorProjectSaveContext) => Promise<boolean | EditorProjectSaveOutcome>,
    allowLegacyBoolean: boolean,
  ): Promise<{ outcome: EditorProjectSaveOutcome; timedOut: boolean }> {
    const controller = new AbortController();
    let timeoutToken: unknown;
    let hasTimeoutToken = false;
    let rawResult: Promise<boolean | EditorProjectSaveOutcome>;
    try {
      rawResult = Promise.resolve(phase({ revision, signal: controller.signal }));
    } catch {
      rawResult = Promise.resolve(false);
    }
    const phaseResult = rawResult.then(
      (value) => ({ outcome: normalizeOutcome(value, allowLegacyBoolean), timedOut: false }),
      () => ({ outcome: { kind: "error" } as EditorProjectSaveOutcome, timedOut: false }),
    );
    const timeoutResult = new Promise<{
      outcome: EditorProjectSaveOutcome;
      timedOut: boolean;
    }>((resolve) => {
      timeoutToken = scheduleTimeout(() => {
        controller.abort();
        resolve({ outcome: { kind: "error" }, timedOut: true });
      }, requestTimeoutMs);
      hasTimeoutToken = true;
    });
    const result = await Promise.race([phaseResult, timeoutResult]);
    if (hasTimeoutToken) cancelTimeout(timeoutToken);
    return result;
  }

  async function runRequest(request: SaveRequest): Promise<EditorProjectSaveOutcome> {
    const primary = await runBoundedPhase(request.revision, request.save, true);
    const needsReconciliation = primary.timedOut || primary.outcome.kind === "ambiguous";
    if (!needsReconciliation) return primary.outcome;
    if (!request.reconcile) return { kind: "error" };

    const reconciled = await runBoundedPhase(request.revision, request.reconcile, false);
    if (!reconciled.timedOut && reconciled.outcome.kind === "saved") {
      return { kind: "saved" };
    }
    return { kind: "blocked" };
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
        let outcome: EditorProjectSaveOutcome = { kind: "error" };
        try {
          outcome = await runRequest(request);
        } catch {
          outcome = { kind: "error" };
        }
        if (outcome.kind === "blocked") {
          const latestRequest = lane.pending ?? request;
          lane.pending = null;
          const event: EditorProjectSaveEvent = {
            projectId: latestRequest.projectId,
            revision: latestRequest.revision,
            status: "error",
          };
          publish(latestRequest, "error");
          if (request.onBlocked && request.isActive()) {
            try {
              request.onBlocked(event);
            } catch {
              // Recovery callbacks cannot affect lane release.
            }
          }
          // Presentation callbacks may enqueue synchronously; a blocked lane cannot
          // allow those writes to escape before explicit conflict resolution.
          lane.pending = null;
          break;
        }
        if (lane.latestRevision === request.revision && !lane.pending) {
          publish(request, outcome.kind === "saved" ? "saved" : "error");
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
      reconcile: input.reconcile,
      onBlocked: input.onBlocked,
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

  return { seedRevision, reserveRevisionAbove, revisionWatermark, enqueue, whenIdle, laneCount };
}

export const editorProjectSaveQueue = createEditorProjectSaveQueue();
