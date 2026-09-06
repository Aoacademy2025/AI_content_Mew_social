import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Execute the real hook's window-keydown effect, including registration/cleanup.
// Native media playback itself is covered by browser QA; here we assert that a
// bubbled media key never changes the timeline or cancels the native default.
const source = readFileSync("src/app/(dashboard)/video-editor/_v2/usePostPhaseEditor.ts", "utf8");
const tree = ts.createSourceFile("usePostPhaseEditor.ts", source, ts.ScriptTarget.Latest, true);
const effects: ts.ArrowFunction[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect") {
    const callback = node.arguments[0];
    if (callback && ts.isArrowFunction(callback) && callback.getText(tree).includes('window.addEventListener("keydown"')) {
      effects.push(callback);
    }
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(effects.length, 1, "exercise the unique post-editor keyboard registration");
const compiled = ts.transpileModule(`const mount = ${effects[0].getText(tree)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const target = new EventTarget();
let plays = 0;
let pauses = 0;
let undos = 0;
let redos = 0;
const video = {
  paused: true, ended: false, currentTime: 10, duration: 30,
  play() { plays++; this.paused = false; return Promise.resolve(); },
  pause() { pauses++; this.paused = true; },
};
const mount = new Function("window", "videoRef", "undoCaptions", "redoCaptions", `${compiled}\nreturn mount;`)(
  target, { current: video }, () => undos++, () => redos++,
) as () => () => void;
const cleanup = mount();
function press(tagName: string, key: string, modifiers: Record<string, boolean> = {}, prevented = false) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, {
    target: { value: { tagName } }, key: { value: key },
    ctrlKey: { value: modifiers.ctrlKey ?? false }, metaKey: { value: modifiers.metaKey ?? false },
    altKey: { value: modifiers.altKey ?? false }, shiftKey: { value: modifiers.shiftKey ?? false },
  });
  if (prevented) event.preventDefault();
  target.dispatchEvent(event);
  return event;
}
function state() { return [plays, pauses, undos, redos, video.currentTime, video.paused]; }

for (const tag of ["AUDIO", "VIDEO"]) {
  for (const key of [" ", "ArrowLeft", "ArrowRight"]) {
    const before = state();
    const event = press(tag, key);
    assert.deepEqual(state(), before, `${tag} ${JSON.stringify(key)} must not play/pause/seek the timeline`);
    assert.equal(event.defaultPrevented, false, `${tag} retains its native keyboard default`);
  }
}
for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
  const before = state();
  assert.equal(press(tag, " ").defaultPrevented, false);
  assert.equal(press(tag, "z", { ctrlKey: true }).defaultPrevented, false);
  assert.deepEqual(state(), before, "form controls retain their own keys");
}
assert.equal(press("DIV", " ").defaultPrevented, true);
assert.equal(plays, 1, "canvas Space still plays the timeline");
press("DIV", " ");
assert.equal(pauses, 1, "canvas Space still pauses the timeline");
press("DIV", "ArrowLeft");
assert.equal(video.currentTime, 9);
press("DIV", "ArrowRight");
assert.equal(video.currentTime, 10);
press("DIV", "z", { ctrlKey: true });
press("DIV", "Z", { metaKey: true, shiftKey: true });
press("DIV", "y", { ctrlKey: true });
assert.equal(undos, 1);
assert.equal(redos, 2);
const beforePrevented = state();
press("DIV", " ", {}, true);
assert.deepEqual(state(), beforePrevented, "a key already handled by a child is not handled twice");
cleanup();
const beforeUnmount = state();
press("DIV", " ");
assert.deepEqual(state(), beforeUnmount, "unmount removes the global listener");
console.log("editor-media-keys: native media isolation, canvas shortcuts, form controls and cleanup pass");
