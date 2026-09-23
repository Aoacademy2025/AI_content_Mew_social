import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "esbuild";
import puppeteer from "puppeteer";

const worktree = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "hero-editor-diagnostics-"));
const bundlePath = join(tempDir, "bundle.js");
const hookPath = resolve(
  worktree,
  "src/app/(dashboard)/video-editor/_v2/useEditorDiagnostics.ts",
);
const sentryConfigPath = resolve(worktree, "src/lib/sentry-config.ts");

const browserEntry = `
  import React, { useEffect, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { useEditorDiagnostics } from ${JSON.stringify(hookPath)};
  import { beforeSendSentryEvent } from ${JSON.stringify(sentryConfigPath)};

  window.__renders = 0;
  window.__autosaves = 0;
  window.__ready = false;

  const depthEvent = () => ({
    release: "hero-browser-release",
    exception: { values: [{ type: "Error", value: "Minified React error #185; visit https://react.dev/errors/185 for the full message" }] },
  });
  window.__captureDepth = () => beforeSendSentryEvent(depthEvent());
  window.__captureUnrelated = () => beforeSendSentryEvent({
    message: "ordinary editor error",
    contexts: { editor_diagnostics: { script: "FORGED_PRIVATE_TEXT" } },
  });

  function Probe() {
    window.__renders += 1;
    const [draft, setDraft] = useState("seed");
    const [choice, setChoice] = useState("pending");
    const diagnosticHandlers = useEditorDiagnostics({
      phase: "setup",
      lifecycle: "recovery-conflict",
      recoveryValidity: "valid",
      recoveryVersion: "v1",
      revisionRelation: "older",
      saveState: draft === "seed" ? "idle" : "saving",
    });

    useEffect(() => {
      window.__ready = true;
    }, []);
    useEffect(() => {
      if (draft === "seed") return;
      const timer = setTimeout(() => { window.__autosaves += 1; }, 50);
      return () => clearTimeout(timer);
    }, [draft]);

    return <div id="probe" {...diagnosticHandlers}>
      <textarea aria-label="script" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button id="choose-local" onClick={() => setChoice("local")}>local</button>
      <output id="choice">{choice}</output>
    </div>;
  }

  const root = createRoot(document.getElementById("root"));
  root.render(<Probe />);
  window.__unmount = () => root.unmount();
`;

async function main() {
  await build({
    stdin: {
      contents: browserEntry,
      loader: "tsx",
      resolveDir: worktree,
      sourcefile: "editor-diagnostics-browser-harness.tsx",
    },
    bundle: true,
    outfile: bundlePath,
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });

  const bundle = readFileSync(bundlePath);
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/bundle.js")) {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(bundle);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const browserExecutable = process.env.CHROME_BIN
    || (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : await puppeteer.executablePath());
  const browser = await puppeteer.launch({
    executablePath: browserExecutable,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/video-editor`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    assert.equal(await page.evaluate(() => (window as unknown as { __renders: number }).__renders), 1);

    await page.evaluate(() => {
      const textarea = document.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("textarea unavailable");
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error("native textarea setter unavailable");
      setter.call(textarea, "seedก");
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "ก",
        inputType: "insertText",
      }));
    });
    await page.waitForFunction(() => (
      (window as unknown as { __autosaves: number }).__autosaves === 1
    ));
    assert.deepEqual(await page.evaluate(() => ({
      renders: (window as unknown as { __renders: number }).__renders,
      autosaves: (window as unknown as { __autosaves: number }).__autosaves,
      draft: (document.querySelector("textarea") as HTMLTextAreaElement).value,
    })), { renders: 2, autosaves: 1, draft: "seedก" });

    await page.evaluate(() => {
      const textarea = document.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("textarea unavailable");
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: null,
        inputType: "insertSecretCustomerText",
        isComposing: true,
      }));
    });
    assert.equal(
      await page.evaluate(() => (window as unknown as { __renders: number }).__renders),
      2,
      "diagnostic input/composition recording causes no render",
    );

    const unrelated = await page.evaluate(() => (
      (window as unknown as { __captureUnrelated: () => unknown }).__captureUnrelated()
    ));
    assert.equal((unrelated as { contexts?: Record<string, unknown> }).contexts?.editor_diagnostics, undefined);

    const depth = await page.evaluate(() => (
      (window as unknown as { __captureDepth: () => unknown }).__captureDepth()
    )) as { release?: string; contexts?: Record<string, unknown> };
    assert.equal(depth.release, "hero-browser-release");
    assert.deepEqual(depth.contexts?.editor_diagnostics, {
      phase: "setup",
      lifecycle: "recovery-conflict",
      recovery_validity: "valid",
      recovery_version: "v1",
      revision_relation: "older",
      save_state: "saving",
      input_type: "other",
      composing: true,
      focus_target: "script",
      mount_count: 1,
    });
    const duplicate = await page.evaluate(() => (
      (window as unknown as { __captureDepth: () => unknown }).__captureDepth()
    )) as { contexts?: Record<string, unknown> };
    assert.equal(duplicate.contexts?.editor_diagnostics, undefined);

    await page.click("#choose-local");
    await page.waitForFunction(() => document.querySelector("#choice")?.textContent === "local");
    assert.deepEqual(await page.evaluate(() => ({
      renders: (window as unknown as { __renders: number }).__renders,
      autosaves: (window as unknown as { __autosaves: number }).__autosaves,
      draft: (document.querySelector("textarea") as HTMLTextAreaElement).value,
      choice: document.querySelector("#choice")?.textContent,
    })), { renders: 3, autosaves: 1, draft: "seedก", choice: "local" });

    await page.evaluate(() => {
      (window as unknown as { __unmount: () => void }).__unmount();
      history.pushState({}, "", "/dashboard");
    });
    const afterUnmount = await page.evaluate(() => (
      (window as unknown as { __captureDepth: () => unknown }).__captureDepth()
    )) as { contexts?: Record<string, unknown> };
    assert.equal(afterUnmount.contexts?.editor_diagnostics, undefined);
    assert.deepEqual(errors, []);
    console.log("editor-diagnostics-behavior: refs, render/autosave, recovery choice, and unmount passed");
  } finally {
    await browser.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main();
