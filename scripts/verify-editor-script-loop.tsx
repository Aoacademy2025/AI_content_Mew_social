// Run with: npx tsx scripts/verify-editor-script-loop.tsx
// Diagnostic probe only: this is not a regression test until it reproduces the Sentry failure.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const exactReactVersion = "19.3.0-canary-cbb046ab-20260731";
const worktree = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "hero-editor-script-loop-"));
const bundlePath = join(tempDir, "bundle.js");
const editorShellPath = resolve(worktree, "src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx");
const compiledReact = resolve(worktree, "node_modules/next/dist/compiled/react");
const compiledReactDom = resolve(worktree, "node_modules/next/dist/compiled/react-dom");
const injectedReactDepthError = process.env.HERO_EDITOR_LOOP_INJECT_REACT_DEPTH_ERROR === "production"
  ? "Minified React error #185; visit https://react.dev/errors/185 for the full message"
  : process.env.HERO_EDITOR_LOOP_INJECT_REACT_DEPTH_ERROR === "development"
    ? "Maximum update depth exceeded. This can happen when a component repeatedly calls setState."
    : null;
const reactMaximumDepthError = /Maximum update depth exceeded|Minified React error #185\b|react\.dev\/errors\/185\b/;

const browserEntry = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { EditorV2Shell } from ${JSON.stringify(editorShellPath)};

  window.__heroErrors = [];
  window.__heroCreatedProjects = 0;
  window.__heroPatchBodies = [];
  window.addEventListener("error", (event) => {
    window.__heroErrors.push(String(event.error?.message || event.message));
  });
  if (${JSON.stringify(injectedReactDepthError)} !== null) {
    setTimeout(() => {
      throw new Error(${JSON.stringify(injectedReactDepthError)});
    }, 0);
  }

  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  window.fetch = async (input, init) => {
    const path = String(input);
    if (path.startsWith("/api/editor-projects/") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      window.__heroPatchBodies.push(body);
      return json({ project: {
        id: path.split("/").pop(),
        status: "draft",
        draft: body.draft,
        draftRevision: body.draftRevision,
        updatedAt: "2026-09-22T06:00:00.000Z",
      }});
    }
    if (path === "/api/editor-projects/loop-project") return json({ project: {
      id: "loop-project",
      status: "draft",
      draft: { mode: "script", script: "ก่อนแก้" },
      draftRevision: 0,
      updatedAt: "2026-09-22T05:57:00.000Z",
    }});
    if (path === "/api/editor-projects" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      window.__heroCreatedProjects += 1;
      return json({ project: {
        id: "new-project",
        title: body.title,
        status: "draft",
        draft: body.draft,
        draftRevision: 0,
        updatedAt: "2026-09-22T06:00:00.000Z",
      }}, 201);
    }
    if (path === "/api/editor-projects") return json({ projects: [], total: 0 });
    if (path === "/api/user/video-settings") return json({
      ttsProvider: "elevenlabs",
      elevenlabsVoiceId: "voice-1",
    });
    if (path === "/api/user/brand-assets") return json({ defaultLogo: null });
    if (path === "/api/videos/usage") return json({});
    if (path === "/api/user/me") return json({ id: "account-1", plan: "PRO" });
    if (path === "/api/omnivoice/status") return json({ enabled: false });
    if (path === "/api/elevenlabs/voices") return json({ error: "provider rejected" }, 422);
    throw new Error("unexpected fetch: " + path);
  };

  window.__heroReactVersion = React.version;
  createRoot(document.getElementById("root")).render(<EditorV2Shell />);
`;

async function main() {
  await build({
    stdin: {
      contents: browserEntry,
      loader: "tsx",
      resolveDir: worktree,
      sourcefile: "editor-script-loop-browser-harness.tsx",
    },
    bundle: true,
    outfile: bundlePath,
    platform: "browser",
    format: "iife",
    sourcemap: "inline",
    banner: {
      js: 'var process = { env: { NODE_ENV: "production", NEXT_PUBLIC_CLIP_CUTAWAY: "0", NEXT_PUBLIC_OMNIVOICE: "0" } };',
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_CLIP_CUTAWAY": '"0"',
      "process.env.NEXT_PUBLIC_OMNIVOICE": '"0"',
    },
    alias: {
      react: compiledReact,
      "react-dom": compiledReactDom,
    },
    plugins: [{
      name: "editor-script-loop-stubs",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /DirectAvatarUpload$/ }, () => ({
          path: "direct-avatar-upload",
          namespace: "editor-script-loop-stub",
        }));
        pluginBuild.onResolve({ filter: /^@clerk\/nextjs$/ }, () => ({
          path: "clerk-nextjs",
          namespace: "editor-script-loop-stub",
        }));
        pluginBuild.onResolve({ filter: /^next\/(link|navigation|image|font\/google)$/ }, (args) => ({
          path: args.path,
          namespace: "editor-script-loop-stub",
        }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "editor-script-loop-stub" }, (args) => ({
          contents: args.path === "clerk-nextjs"
            ? "export const getToken = async () => null; export const useClerk = () => ({ signOut: async () => {} });"
            : args.path === "next/navigation"
              ? "export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {} }); export const usePathname = () => '/video-editor';"
              : args.path === "next/font/google"
                ? "export const Kanit = () => ({ variable: 'kanit' }); export const Noto_Sans_Thai = () => ({ variable: 'noto' });"
                : args.path === "next/link" || args.path === "next/image"
                  ? "import React from 'react'; export default function Stub(props) { return React.createElement(props.href ? 'a' : 'img', props, props.children); }"
                  : "export const DirectAvatarUpload = () => null;",
          loader: args.path === "next/link" || args.path === "next/image" ? "js" : "js",
        }));
      },
    }],
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
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => pageErrors.push(`console.${message.type()}: ${message.text()}`));
    await page.goto(`http://127.0.0.1:${address.port}/video-editor?projectId=loop-project`);
    try { await page.waitForSelector("textarea", { timeout: 5_000 }); }
    catch (error) { throw new Error(`editor harness did not become ready: ${pageErrors.join(" | ")}`, { cause: error }); }
    const runtimeVersion = await page.evaluate(() => (
      (window as unknown as { __heroReactVersion?: string }).__heroReactVersion
    ));
    assert.equal(runtimeVersion, exactReactVersion, "matches the production React runtime");

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 4_000));
    await page.click("textarea");
    await page.keyboard.type("ก");
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "ก่อนแก้ก");
    await page.waitForFunction(() => (
      (window as unknown as { __heroPatchBodies?: Array<{ draft?: { script?: string } }> })
        .__heroPatchBodies?.some((body) => body.draft?.script === "ก่อนแก้ก") === true
    ));
    const state = await page.evaluate(() => ({
      errors: (window as unknown as { __heroErrors: string[] }).__heroErrors,
    }));
    const errors = [...pageErrors, ...state.errors];
    assert.doesNotMatch(errors.join("\n"), reactMaximumDepthError);

    await page.click('button[aria-label="เปิดรายการโปรเจกต์"]');
    const newProject = await page.waitForSelector('::-p-text(โปรเจกต์ใหม่)');
    assert.ok(newProject);
    await newProject.click();
    await page.waitForFunction(() => (
      (window as unknown as { __heroCreatedProjects?: number }).__heroCreatedProjects === 1
        && new URL(window.location.href).searchParams.get("projectId") === "new-project"
    ));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 4_000));
    await page.click("textarea");
    await page.keyboard.type("ก");
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "ก");
    await page.waitForFunction(() => (
      (window as unknown as { __heroPatchBodies?: Array<{ draft?: { script?: string } }> })
        .__heroPatchBodies?.some((body) => body.draft?.script === "ก") === true
    ));

    const pastedScript = "บรรทัดหนึ่ง\nบรรทัดสอง\nบรรทัดสาม";
    await page.evaluate((text) => {
      const textarea = document.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("textarea unavailable");
      textarea.focus();
      textarea.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: "insertFromPaste",
      }));
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error("native textarea setter unavailable");
      setter.call(textarea, text);
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertFromPaste",
      }));
    }, pastedScript);
    await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, {}, pastedScript);
    await page.waitForFunction((text) => (
      (window as unknown as { __heroPatchBodies?: Array<{ draft?: { script?: string } }> })
        .__heroPatchBodies?.some((body) => body.draft?.script === text) === true
    ), {}, pastedScript);

    const composedScript = `${pastedScript}ก`;
    await page.evaluate((text) => {
      const textarea = document.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("textarea unavailable");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) throw new Error("native textarea setter unavailable");
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      setter.call(textarea, text);
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "ก",
        inputType: "insertCompositionText",
        isComposing: true,
      }));
      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "ก" }));
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "ก",
        inputType: "insertText",
      }));
    }, composedScript);
    await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, {}, composedScript);
    await page.waitForFunction((text) => (
      (window as unknown as { __heroPatchBodies?: Array<{ draft?: { script?: string } }> })
        .__heroPatchBodies?.some((body) => body.draft?.script === text) === true
    ), {}, composedScript);
    const resetErrors = await page.evaluate(() => (
      (window as unknown as { __heroErrors: string[] }).__heroErrors
    ));
    assert.doesNotMatch([...pageErrors, ...resetErrors].join("\n"), reactMaximumDepthError);
    console.log("ok: existing-project keyboard edit settles and autosaves");
    console.log("ok: reset-project keyboard, paste, and IME edits settle and autosave");
    console.log("NO_REPRO: Maximum update depth did not occur in the bounded production-runtime probes");
  } finally {
    await browser.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main();
