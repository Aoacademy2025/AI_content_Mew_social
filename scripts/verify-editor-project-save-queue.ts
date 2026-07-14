// Run with: npx tsx scripts/verify-editor-project-save-queue.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createEditorProjectSaveQueue,
  type EditorProjectSaveEvent,
} from "../src/lib/editor-project-save-queue";

type Draft = { script: string };

type ControlledSave = {
  projectId: string;
  draft: Draft;
  complete(ok: boolean): void;
};

function controlledSaver(persisted: Map<string, Draft>, calls: ControlledSave[]) {
  return (projectId: string, draft: Draft) => new Promise<boolean>((resolve) => {
    calls.push({
      projectId,
      draft,
      complete(ok) {
        if (ok) persisted.set(projectId, draft);
        resolve(ok);
      },
    });
  });
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main(): Promise<void> {
  {
    const persisted = new Map<string, Draft>();
    const calls: ControlledSave[] = [];
    const events: EditorProjectSaveEvent[] = [];
    const queue = createEditorProjectSaveQueue<Draft>();
    const save = controlledSaver(persisted, calls);
    const isActive = () => true;
    const onStatus = (event: EditorProjectSaveEvent) => events.push(event);

    const revisionA = queue.enqueue({
      projectId: "project-order",
      draft: { script: "A" },
      save,
      isActive,
      onStatus,
    });
    const revisionB = queue.enqueue({
      projectId: "project-order",
      draft: { script: "B" },
      save,
      isActive,
      onStatus,
    });

    assert.equal(calls.length, 1, "B waits behind the in-flight PATCH A");
    assert.equal(calls[0].draft.script, "A");
    calls[0].complete(true);
    await nextTurn();
    assert.equal(calls.length, 2, "B starts only after A settles");
    assert.equal(calls[1].draft.script, "B");
    calls[1].complete(true);
    await queue.whenIdle("project-order");

    assert.equal(persisted.get("project-order")?.script, "B", "a delayed A cannot overwrite newer B");
    assert.deepEqual(
      events.map(({ revision, status }) => ({ revision, status })),
      [
        { revision: revisionA, status: "saving" },
        { revision: revisionB, status: "saving" },
        { revision: revisionB, status: "saved" },
      ],
      "only the latest revision publishes a terminal save status",
    );
  }

  {
    const calls: ControlledSave[] = [];
    const queue = createEditorProjectSaveQueue<Draft>();
    const save = controlledSaver(new Map(), calls);
    queue.enqueue({ projectId: "project-coalesce", draft: { script: "A" }, save });
    queue.enqueue({ projectId: "project-coalesce", draft: { script: "B" }, save });
    queue.enqueue({ projectId: "project-coalesce", draft: { script: "C" }, save });
    calls[0].complete(true);
    await nextTurn();
    assert.deepEqual(
      calls.map((call) => call.draft.script),
      ["A", "C"],
      "pending autosaves coalesce to the latest draft",
    );
    calls[1].complete(true);
    await queue.whenIdle("project-coalesce");
  }

  {
    const persisted = new Map<string, Draft>();
    const calls: ControlledSave[] = [];
    const events: EditorProjectSaveEvent[] = [];
    const queue = createEditorProjectSaveQueue<Draft>();
    const save = controlledSaver(persisted, calls);
    const revision = queue.enqueue({
      projectId: "project-retry",
      draft: { script: "latest draft" },
      save,
      onStatus: (event) => events.push(event),
    });
    calls[0].complete(false);
    await queue.whenIdle("project-retry");
    assert.deepEqual(events.at(-1), {
      projectId: "project-retry",
      revision,
      status: "error",
    });

    const retryRevision = queue.retry("project-retry", {
      onStatus: (event) => events.push(event),
    });
    assert.ok(retryRevision && retryRevision > revision);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].draft.script, "latest draft", "retry resubmits the latest queued draft");
    calls[1].complete(true);
    await queue.whenIdle("project-retry");
    assert.equal(persisted.get("project-retry")?.script, "latest draft");
    assert.deepEqual(events.at(-1), {
      projectId: "project-retry",
      revision: retryRevision,
      status: "saved",
    });
  }

  {
    const calls: ControlledSave[] = [];
    const events: EditorProjectSaveEvent[] = [];
    const queue = createEditorProjectSaveQueue<Draft>();
    const save = controlledSaver(new Map(), calls);
    let oldMountActive = true;

    queue.enqueue({
      projectId: "same-project",
      draft: { script: "old mount" },
      save,
      isActive: () => oldMountActive,
      onStatus: (event) => events.push(event),
    });
    oldMountActive = false;
    const newRevision = queue.enqueue({
      projectId: "same-project",
      draft: { script: "new mount" },
      save,
      isActive: () => true,
      onStatus: (event) => events.push(event),
    });
    assert.equal(calls.length, 1, "a remount cannot start an overlapping PATCH for the same project");
    calls[0].complete(true);
    await nextTurn();
    assert.equal(calls[1].draft.script, "new mount");
    calls[1].complete(true);
    await queue.whenIdle("same-project");
    assert.equal(
      events.some((event) => event.status !== "saving" && event.revision !== newRevision),
      false,
      "an unmounted observer never receives a terminal status",
    );
  }

  {
    const calls: ControlledSave[] = [];
    const events: EditorProjectSaveEvent[] = [];
    const queue = createEditorProjectSaveQueue<Draft>();
    const save = controlledSaver(new Map(), calls);
    let activeProject = "project-old";
    queue.enqueue({
      projectId: "project-old",
      draft: { script: "old project" },
      save,
      isActive: () => activeProject === "project-old",
      onStatus: (event) => events.push(event),
    });
    activeProject = "project-new";
    const newRevision = queue.enqueue({
      projectId: "project-new",
      draft: { script: "new project" },
      save,
      isActive: () => activeProject === "project-new",
      onStatus: (event) => events.push(event),
    });
    assert.equal(calls.length, 2, "different project lanes do not block each other");
    calls.find((call) => call.projectId === "project-new")!.complete(true);
    calls.find((call) => call.projectId === "project-old")!.complete(true);
    await Promise.all([
      queue.whenIdle("project-old"),
      queue.whenIdle("project-new"),
    ]);
    assert.equal(
      events.some((event) => event.projectId === "project-old" && event.status !== "saving"),
      false,
      "a previous project cannot update the visible terminal status",
    );
    assert.equal(
      events.some((event) => event.revision === newRevision && event.status === "saved"),
      true,
    );
  }

  const projectSource = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/useV2Project.ts",
    "utf8",
  );
  const autosaveStart = projectSource.indexOf("// Persist draft (debounce 1s)");
  const autosaveEnd = projectSource.indexOf("// ข้อมูลอวตาร", autosaveStart);
  assert.ok(autosaveStart >= 0 && autosaveEnd > autosaveStart);
  const autosaveSource = projectSource.slice(autosaveStart, autosaveEnd);
  assert.match(projectSource, /createEditorProjectSaveQueue<V2Draft>\(\)/, "one shared save queue is created");
  assert.match(autosaveSource, /setTimeout\(\(\) => \{[\s\S]*buildDraft\(\)/, "latest draft is captured after the 1s debounce");
  assert.match(autosaveSource, /projectSaveQueue\.enqueue\(\{/, "debounced server saves enter the queue");
  assert.doesNotMatch(autosaveSource, /\bfetch\(/, "the autosave effect cannot launch unordered PATCHes directly");
  assert.match(autosaveSource, /saveRevision\]\);/, "manual retry still re-enters the debounced latest-draft path");
  assert.match(projectSource, /mountedRef\.current\s*=\s*false/, "unmount invalidates visible status observers");
  assert.match(projectSource, /currentProjectIdRef\.current\s*===\s*saveProjectId/, "project changes invalidate old status observers");

  console.log("editor-project-save-queue: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
