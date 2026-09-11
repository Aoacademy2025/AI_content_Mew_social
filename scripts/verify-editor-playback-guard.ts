// HERO-27: pressing play in the video editor and then immediately pausing the
// preview (opening a sheet, clicking a timeline card, pressing space twice)
// left the rejected play() promise unhandled, so an ordinary user action was
// reported as an unhandled production error.
//
// This pins the guard's behaviour and asserts that no media element in either
// editor surface is started without it.
//
// Run: npx tsx scripts/verify-editor-playback-guard.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { startPlayback } from "../src/lib/media-playback";

const ROOT = join(import.meta.dirname, "..");
const EDITOR_DIR = join(ROOT, "src/app/(dashboard)/video-editor");
const CREATOR_PAGE = join(ROOT, "src/app/(dashboard)/video-creator/page.tsx");

/** A media element whose play() behaves the way the browser's does. */
function fakeElement(behaviour: "starts" | "interrupted" | "blocked" | "legacy") {
  let played = false;
  return {
    get played() {
      return played;
    },
    play(): Promise<void> | undefined {
      if (behaviour === "legacy") {
        played = true;
        return undefined; // pre-promise browsers
      }
      if (behaviour === "starts") {
        played = true;
        return Promise.resolve();
      }
      const error =
        behaviour === "interrupted"
          ? Object.assign(
              new Error(
                "The play() request was interrupted by a call to pause().",
              ),
              { name: "AbortError", code: 20 },
            )
          : Object.assign(
              new Error("play() failed because the user didn't interact first"),
              { name: "NotAllowedError" },
            );
      return Promise.reject(error);
    },
  } as unknown as HTMLMediaElement;
}

async function verifyGuardBehaviour(): Promise<void> {
  // The whole point: an interrupted play resolves instead of rejecting.
  const interrupted = fakeElement("interrupted");
  assert.equal(
    await startPlayback(interrupted),
    false,
    "an interrupted play() must resolve false, never reject",
  );

  // A blocked autoplay is reported the same way — also not a rejection.
  assert.equal(
    await startPlayback(fakeElement("blocked")),
    false,
    "a blocked play() must resolve false, never reject",
  );

  // The guard must not swallow success: a caller's playing state depends on it.
  assert.equal(
    await startPlayback(fakeElement("starts")),
    true,
    "a successful play() resolves true",
  );

  // Browsers that predate the play() promise return undefined.
  assert.equal(
    await startPlayback(fakeElement("legacy")),
    true,
    "a play() that returns undefined counts as started",
  );

  // A missing ref is the common React case and must not throw.
  assert.equal(await startPlayback(null), false, "a null element resolves false");
  assert.equal(
    await startPlayback(undefined),
    false,
    "an undefined element resolves false",
  );

  // Nothing may escape: prove no rejection reaches the process, which is
  // exactly what Sentry recorded as `onunhandledrejection`.
  const escaped: unknown[] = [];
  const onRejection = (reason: unknown) => escaped.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    void startPlayback(fakeElement("interrupted"));
    void startPlayback(fakeElement("blocked"));
    // Let the microtask queue and one macrotask turn drain, which is when
    // Node reports an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      escaped,
      [],
      "a discarded startPlayback() must not produce an unhandled rejection",
    );
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

function editorSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(EDITOR_DIR);
  files.push(CREATOR_PAGE);
  return files;
}

/**
 * The source trap. Every `.play()` in these surfaces must be handled one of
 * three ways: through the shared guard, with its own `.catch(...)`, or awaited
 * inside a `try`. An unguarded call reintroduces the bug, and a grep is the
 * only thing that catches the next one.
 */
function verifyNoUnguardedPlay(): void {
  const offenders: string[] = [];

  for (const file of editorSourceFiles()) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    const guardedByTry = /await\s+[A-Za-z_$][\w$.]*\.play\(\)/;

    lines.forEach((line, index) => {
      if (!/\.play\(\)/.test(line)) return;
      if (/\.play\(\)\s*\.catch\b/.test(line)) return; // handles its own rejection
      if (guardedByTry.test(line) && insideTry(lines, index)) return;
      offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `every media play() in the editor surfaces must handle its rejection:\n${offenders.join("\n")}`,
  );
}

/** Walk back from an awaited play() to the nearest enclosing `try {`. */
function insideTry(lines: string[], index: number): boolean {
  for (let i = index; i >= 0 && index - i < 12; i -= 1) {
    if (/\btry\s*\{/.test(lines[i])) return true;
    if (/^\s*(async\s+)?function\b/.test(lines[i])) return false;
  }
  return false;
}

/**
 * The timeline keeps its own `playing` state instead of following the
 * element's play/pause events like the other three surfaces do, so it used to
 * show the pause icon after a play that never started.
 */
function verifyTimelineStateFollowsResult(): void {
  const panel = readFileSync(join(EDITOR_DIR, "_v2/TimelinePanel.tsx"), "utf8");
  const toggle = panel.slice(
    panel.indexOf("function togglePlay"),
    panel.indexOf("function togglePlay") + 500,
  );

  assert.ok(
    toggle.includes("startPlayback("),
    "the timeline toggle must start playback through the shared guard",
  );
  assert.equal(
    /startPlayback\([^)]*\)[^;]*;\s*setPlaying\(true\)/.test(toggle),
    false,
    "the timeline must not claim it is playing before the play promise settles",
  );
  assert.ok(
    /setPlaying\((?:started|ok|playing)\)/.test(toggle) ||
      /then\(setPlaying\)/.test(toggle),
    "the timeline's playing state must come from the play result",
  );
}

async function main(): Promise<void> {
  await verifyGuardBehaviour();
  verifyNoUnguardedPlay();
  verifyTimelineStateFollowsResult();
  console.log("verify-editor-playback-guard: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
