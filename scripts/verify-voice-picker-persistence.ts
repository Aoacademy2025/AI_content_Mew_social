// HERO-119: Verify shared Gemini default voice (Aoede) across UI pickers & backend TTS,
// and prove accountDefaults never overwrite a saved project's geminiVoiceName on reload
// while brand-new projects still inherit account defaults cleanly.
//
// Run with: npm run verify:voice-picker-persistence
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { build } from "esbuild";
import ts from "typescript";
import type { fetch as UndiciFetch } from "undici";

import {
  DEFAULT_GEMINI_VOICE,
  GEMINI_VOICES,
  resolveGeminiVoice,
  resolveGeminiVoiceId,
} from "../src/lib/gemini-voices";
import * as provider from "../src/lib/gemini-tts-provider.server";
import * as internal from "../src/lib/internal-ai-access";
import { pcmSamples, RATE, wav } from "./fixtures/gemini-audio";

import * as bootstrapModule from "../src/lib/editor-project-bootstrap";
import * as journalModule from "../src/lib/editor-project-recovery-journal";
import * as logoOverlayModule from "../src/lib/logo-overlay";
import * as headlineHookModule from "../src/lib/headline-hook";
import * as backgroundMusicModule from "../src/lib/background-music";
import * as lineageModule from "../src/lib/editor-project-autosave-lineage";
import * as ttsProvidersModule from "../src/lib/tts-providers";
import * as editorLayerVisibilityModule from "../src/lib/editor-layer-visibility";
import * as editorDefaultDraftModule from "../src/lib/editor-default-draft";
import * as editorStylePresetModule from "../src/lib/editor-style-preset-contract";
import * as narrationTargetModule from "../src/lib/narration-target";
import * as musicMoodModule from "../src/lib/music-mood";
import * as logoEntitlementModule from "../src/lib/logo-entitlement";
import * as geminiVoiceStylesModule from "../src/lib/gemini-voice-styles";
import * as geminiVoicesModule from "../src/lib/gemini-voices";
import * as stylePackCatalogModule from "../src/lib/style-pack-catalog";
import * as brollWindowStyleModule from "../src/lib/broll-window-style";
import * as transitionSfxModule from "../src/lib/transition-sfx";
import * as videoTemplateApplyModule from "../src/lib/video-template-apply";
import {
  createEditorProjectSaveQueue,
  type EditorProjectSaveInput,
} from "../src/lib/editor-project-save-queue";

type JsonRecord = Record<string, unknown>;
type FetchInit = { method?: string; body?: string; signal?: AbortSignal; [key: string]: unknown };
type FetchCall = { method: string; url: string; init: FetchInit };
type ResponseLike = { ok: boolean; status: number; json(): Promise<unknown> };

function response(status: number, payload: unknown): ResponseLike {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class MemoryStorage implements journalModule.RecoveryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class FakeClock {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; task: () => void }>();
  setTimeout = (task: () => void, delay = 0): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delay, task });
    return id;
  };
  clearTimeout = (id: number): void => { this.tasks.delete(id); };
  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, item]) => item.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].task();
    }
    this.now = target;
  }
}

class SharedEditorServer {
  private readonly projects = new Map<string, JsonRecord>();
  setProject(projectId: string, draftRevision: number, draft: JsonRecord): void {
    this.projects.set(projectId, {
      id: projectId,
      draftRevision,
      draft: structuredClone(draft),
      status: "draft",
      updatedAt: "2026-11-24T10:00:00.000Z",
    });
  }
  read(projectId: string): JsonRecord | null {
    const value = this.projects.get(projectId);
    return value ? structuredClone(value) : null;
  }
  patch(projectId: string, body: JsonRecord): ResponseLike {
    const current = this.projects.get(projectId);
    if (!current) return response(404, { error: "not_found" });
    const currentRevision = current.draftRevision as number;
    const revision = body.draftRevision;
    const expected = body.expectedDraftRevision;
    if (
      typeof revision !== "number"
      || !Number.isSafeInteger(revision)
      || revision <= currentRevision
      || (Object.hasOwn(body, "expectedDraftRevision") && expected !== currentRevision)
    ) {
      return response(409, { error: "stale_revision", project: structuredClone(current) });
    }
    this.setProject(projectId, revision, body.draft as JsonRecord);
    const saved = this.projects.get(projectId)!;
    if (typeof body.title === "string") saved.title = body.title;
    return response(200, { project: structuredClone(saved) });
  }
}

class FetchMock {
  readonly calls: FetchCall[] = [];
  private readonly routes = new Map<string, Array<() => Promise<ResponseLike>>>();
  private nextProject = 1;
  defaultVideoSettings: JsonRecord = {
    ttsProvider: "gemini",
    geminiVoiceName: "Puck",
    elevenlabsVoiceId: "",
    heygenAvatarId: "",
  };

  constructor(private readonly server?: SharedEditorServer) {}

  enqueue(method: string, url: string, result: ResponseLike | Promise<ResponseLike>): void {
    const key = `${method.toUpperCase()} ${url}`;
    const items = this.routes.get(key) ?? [];
    items.push(() => Promise.resolve(result));
    this.routes.set(key, items);
  }

  fetch = async (urlValue: unknown, initValue: unknown = {}): Promise<ResponseLike> => {
    const url = String(urlValue);
    const init = initValue as FetchInit;
    const method = (init.method ?? "GET").toUpperCase();
    this.calls.push({ method, url, init });
    const key = `${method} ${url}`;
    const queued = this.routes.get(key);
    const handler = queued?.shift();
    if (handler) return handler();
    if (url === "/api/user/video-settings") return response(200, this.defaultVideoSettings);
    if (url === "/api/videos/usage") return response(200, null);
    if (url === "/api/music") return response(200, { tracks: [] });
    if (url === "/api/user/brand-assets") return response(200, { defaultLogo: null });
    if (url === "/api/editor-projects" && method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as JsonRecord;
      const id = `new-${this.nextProject++}`;
      this.server?.setProject(id, 0, body.draft as JsonRecord);
      return response(200, {
        project: { id, draftRevision: 0, draft: body.draft, status: "draft" },
      });
    }
    if (url.startsWith("/api/editor-projects/") && method === "GET" && this.server) {
      const id = decodeURIComponent(url.slice("/api/editor-projects/".length));
      const stored = this.server.read(id);
      return stored ? response(200, { project: stored }) : response(404, { error: "not_found" });
    }
    if (url.startsWith("/api/editor-projects/") && method === "PATCH") {
      const body = JSON.parse(init.body ?? "{}") as JsonRecord;
      const id = decodeURIComponent(url.slice("/api/editor-projects/".length));
      if (this.server) return this.server.patch(id, body);
      return response(200, {
        project: { id, draftRevision: body.draftRevision, draft: body.draft, status: "draft" },
      });
    }
    if (url.startsWith("/api/heygen/avatar-info")) return response(404, null);
    if (url === "/api/elevenlabs/voices") return response(200, { voices: [] });
    throw new Error(`unhandled fetch: ${key}`);
  };
}

type StateSlot = { kind: "state"; value: unknown; setter: (next: unknown) => void };
type RefSlot = { kind: "ref"; value: { current: unknown } };
type MemoSlot = { kind: "memo"; value: unknown; deps: readonly unknown[] | undefined };
type EffectSlot = {
  kind: "effect";
  deps: readonly unknown[] | undefined;
  create: () => void | (() => void);
  cleanup?: () => void;
};
type HookSlot = StateSlot | RefSlot | MemoSlot | EffectSlot;

function depsEqual(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  return !!left && !!right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
}

class HookRunner<T> {
  private readonly slots: HookSlot[] = [];
  private cursor = 0;
  private dirty = false;
  private mounted = false;
  private readonly pendingEffects = new Set<number>();
  current!: T;

  constructor(private readonly hook: () => T) {}

  readonly react = {
    useState: <V,>(initial: V | (() => V)): [V, (next: V | ((value: V) => V)) => void] => {
      const index = this.cursor++;
      let slot = this.slots[index] as StateSlot | undefined;
      if (!slot) {
        slot = {
          kind: "state",
          value: typeof initial === "function" ? (initial as () => V)() : initial,
          setter: (next: unknown) => {
            const previous = slot!.value as V;
            slot!.value = typeof next === "function" ? (next as (value: V) => V)(previous) : next;
            this.dirty = true;
          },
        };
        this.slots[index] = slot;
      }
      return [slot.value as V, slot.setter as (next: V | ((value: V) => V)) => void];
    },
    useRef: <V,>(initial: V): { current: V } => {
      const index = this.cursor++;
      let slot = this.slots[index] as RefSlot | undefined;
      if (!slot) {
        slot = { kind: "ref", value: { current: initial } };
        this.slots[index] = slot;
      }
      return slot.value as { current: V };
    },
    useCallback: <V,>(callback: V, deps: readonly unknown[]): V => {
      const index = this.cursor++;
      let slot = this.slots[index] as MemoSlot | undefined;
      if (!slot || !depsEqual(slot.deps, deps)) {
        slot = { kind: "memo", value: callback, deps: [...deps] };
        this.slots[index] = slot;
      }
      return slot.value as V;
    },
    useEffect: (create: () => void | (() => void), deps?: readonly unknown[]): void => {
      const index = this.cursor++;
      let slot = this.slots[index] as EffectSlot | undefined;
      if (!slot) {
        slot = { kind: "effect", deps: undefined, create };
        this.slots[index] = slot;
      }
      slot.create = create;
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps ? [...deps] : undefined;
        this.pendingEffects.add(index);
      }
    },
  };

  mount(): void {
    this.mounted = true;
    this.dirty = true;
    this.flush();
  }

  flush(): void {
    let guard = 0;
    while ((this.dirty || this.pendingEffects.size > 0) && guard++ < 100) {
      if (this.dirty) {
        this.dirty = false;
        this.cursor = 0;
        this.current = this.hook();
      }
      const effects = [...this.pendingEffects];
      this.pendingEffects.clear();
      for (const index of effects) {
        const effect = this.slots[index] as EffectSlot;
        effect.cleanup?.();
        effect.cleanup = effect.create() || undefined;
      }
    }
    assert.ok(guard < 100, "hook runner reached a stable render");
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const slot of this.slots) if (slot?.kind === "effect") slot.cleanup?.();
  }
}

type ProjectHook = {
  projectId: string | null;
  projectReady: boolean;
  voiceEngine: string;
  setVoiceEngine(value: string): void;
  geminiVoiceName: string;
  setGeminiVoiceName(value: string): void;
  voiceId: string;
  avatarId: string;
  mixPreset: string;
  brollSource: string;
  resetProject(): Promise<string | null>;
  acceptAuthoritativeProjectSnapshot(project: Record<string, unknown>): boolean;
};

const hookSource = readFileSync("src/app/(dashboard)/video-editor/_v2/useV2Project.ts", "utf8");
const compiledHook = ts.transpileModule(hookSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: "useV2Project.ts",
}).outputText;

function createHarness(options: {
  search?: string;
  storage?: MemoryStorage;
  server?: SharedEditorServer;
  fetchMe?: Promise<JsonRecord | null>;
  defaultVideoSettings?: JsonRecord;
} = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const clock = new FakeClock();
  const fetchMock = new FetchMock(options.server);
  if (options.defaultVideoSettings) {
    fetchMock.defaultVideoSettings = options.defaultVideoSettings;
  }
  const queue = createEditorProjectSaveQueue({
    scheduleTimeout: clock.setTimeout,
    cancelTimeout: clock.clearTimeout,
  });
  const windowMock = { localStorage: storage, location: { search: options.search ?? "" } };
  let runner!: HookRunner<ProjectHook>;
  const module = { exports: {} as Record<string, unknown> };
  const fakeReact: Record<string, unknown> = {};
  const requireMock = (specifier: string): unknown => {
    if (specifier === "react") return fakeReact;
    if (specifier === "@/lib/use-me") {
      const resolveBrandVisualClientAccess = (account: JsonRecord | null | undefined) =>
        account?.brandVisualAllowed === true;
      return {
        fetchMe: () => options.fetchMe ?? Promise.resolve({ id: "user-1", role: "USER", plan: "PRO" }),
        resolveBrandVisualClientAccess,
        resolveBrandLibraryClientAccess: resolveBrandVisualClientAccess,
      };
    }
    if (specifier === "../_components/types") {
      return { DEFAULT_AUTO_MIX_PROVIDERS: ["video", "pexels-photo", "pixabay-photo"] };
    }
    if (specifier === "./mix-presets") {
      return {
        PRESET_PROVIDERS: {
          free: null,
          recommended: ["video", "pexels-photo", "pixabay-photo", "kie-ai"],
          full: ["kie-ai"],
        },
        presetBrollSource: (preset: string) => (preset === "free" ? "stock" : "automix"),
      };
    }
    if (specifier === "@/lib/narration-target") return narrationTargetModule;
    if (specifier === "@/lib/editor-default-draft") return editorDefaultDraftModule;
    if (specifier === "@/lib/editor-project-save-queue") {
      return {
        editorProjectSaveQueue: {
          seedRevision: (id: string, rev: number) => queue.seedRevision(id, rev),
          revisionWatermark: (id: string) => queue.revisionWatermark(id),
          reserveRevisionAbove: (id: string, obs: number) => queue.reserveRevisionAbove(id, obs),
          enqueue: (input: EditorProjectSaveInput) => queue.enqueue(input),
          whenIdle: (id: string) => queue.whenIdle(id),
        },
      };
    }
    if (specifier === "@/lib/editor-project-bootstrap") return bootstrapModule;
    if (specifier === "@/lib/editor-project-recovery-journal") return journalModule;
    if (specifier === "@/lib/editor-project-autosave-lineage") return lineageModule;
    if (specifier === "@/lib/logo-overlay") return logoOverlayModule;
    if (specifier === "@/lib/headline-hook") return headlineHookModule;
    if (specifier === "@/lib/background-music") return backgroundMusicModule;
    if (specifier === "@/lib/editor-layer-visibility") return editorLayerVisibilityModule;
    if (specifier === "@/lib/editor-style-preset-contract") return editorStylePresetModule;
    if (specifier === "@/lib/tts-providers") return ttsProvidersModule;
    if (specifier === "@/lib/music-mood") return musicMoodModule;
    if (specifier === "@/lib/logo-entitlement") return logoEntitlementModule;
    if (specifier === "@/lib/gemini-voice-styles") return geminiVoiceStylesModule;
    if (specifier === "@/lib/gemini-voices") return geminiVoicesModule;
    if (specifier === "@/lib/style-pack-catalog") return stylePackCatalogModule;
    if (specifier === "@/lib/broll-window-style") return brollWindowStyleModule;
    if (specifier === "@/lib/transition-sfx") return transitionSfxModule;
    if (specifier === "@/lib/video-template-apply") return videoTemplateApplyModule;
    if (specifier === "@/lib/video-account-defaults") return { saveVideoAccountDefaults: async () => ({ ok: true }) };
    if (specifier === "@/lib/client-request-cache") return { fetchClientJson: async () => ({ ok: true, status: 200, data: null }) };
    if (specifier === "@/lib/authenticated-fetch") return { authenticatedFetch: fetchMock.fetch };
    if (specifier === "../_hooks/useOmniVoiceAvailability") return { useOmniVoiceAvailability: () => false };
    throw new Error(`unhandled hook import: ${specifier}`);
  };
  const factory = new Function(
    "require", "module", "exports", "fetch", "window", "setTimeout", "clearTimeout",
    compiledHook,
  );
  Object.assign(fakeReact, {
    useState: (...args: unknown[]) => runner.react.useState(args[0]),
    useRef: (...args: unknown[]) => runner.react.useRef(args[0]),
    useCallback: (...args: unknown[]) => runner.react.useCallback(args[0], args[1] as readonly unknown[]),
    useEffect: (...args: unknown[]) => runner.react.useEffect(
      args[0] as () => void | (() => void),
      args[1] as readonly unknown[] | undefined,
    ),
  });
  factory(
    requireMock,
    module,
    module.exports,
    fetchMock.fetch,
    windowMock,
    clock.setTimeout,
    clock.clearTimeout,
  );
  const useV2Project = module.exports.useV2Project as () => ProjectHook;
  runner = new HookRunner(useV2Project);
  return { runner, storage, fetchMock, clock };
}

async function settle(runner: HookRunner<ProjectHook>, turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    runner.flush();
  }
}

function postDrafts(fetchMock: FetchMock): JsonRecord[] {
  return fetchMock.calls
    .filter((c) => c.method === "POST" && c.url === "/api/editor-projects")
    .map((c) => (JSON.parse(c.init.body ?? "{}") as { draft: JsonRecord }).draft);
}

function patchDrafts(fetchMock: FetchMock): JsonRecord[] {
  return fetchMock.calls
    .filter((c) => c.method === "PATCH" && c.url.startsWith("/api/editor-projects/"))
    .map((c) => (JSON.parse(c.init.body ?? "{}") as { draft: JsonRecord }).draft);
}

async function verifySharedDefaultAndTtsRoute(): Promise<void> {
  assert.equal(DEFAULT_GEMINI_VOICE, "Aoede", "shared default Gemini voice constant is Aoede");
  assert.equal(GEMINI_VOICES[0].id, "Puck", "first catalog voice is Puck so fallback bugs cannot hide");

  for (const unsetOrUnknown of [undefined, null, "", "   ", "UnknownVoice", 123]) {
    assert.equal(resolveGeminiVoice(unsetOrUnknown).id, "Aoede", `resolveGeminiVoice(${String(unsetOrUnknown)}) → Aoede`);
    assert.equal(resolveGeminiVoiceId(unsetOrUnknown), "Aoede", `resolveGeminiVoiceId(${String(unsetOrUnknown)}) → Aoede`);
  }
  assert.equal(resolveGeminiVoice("Leda").id, "Leda");
  assert.equal(resolveGeminiVoice("  Puck  ").id, "Puck");
  assert.equal(resolveGeminiVoice("Aoede").id, "Aoede");

  // UI & backend source contracts: no picker may fall back to GEMINI_VOICES[0] (Puck).
  const step2Source = readFileSync("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx", "utf8");
  assert.doesNotMatch(step2Source, /GEMINI_VOICES\[0\]/, "Step2Elements never falls back to GEMINI_VOICES[0] (Puck)");
  assert.match(step2Source, /resolveGeminiVoice\(p\.geminiVoiceName\)/, "Step2Elements resolves Gemini voice via shared helper");
  assert.match(step2Source, /value=\{geminiVoice\.id\}/, "Step2Elements select binds the resolved voice id (Aoede when unset)");

  const orderPanelSource = readFileSync("src/app/(dashboard)/video-editor/_components/OrderPanel.tsx", "utf8");
  assert.doesNotMatch(orderPanelSource, /GEMINI_VOICES\[0\]/, "OrderPanel never falls back to GEMINI_VOICES[0] (Puck)");
  assert.match(orderPanelSource, /resolveGeminiVoice\(p\.geminiVoiceName\)/, "OrderPanel resolves Gemini voice via shared helper");

  const ttsRouteSource = readFileSync("src/app/api/videos/tts-gemini/route.ts", "utf8");
  assert.match(ttsRouteSource, /DEFAULT_GEMINI_VOICE/, "tts-gemini route uses shared DEFAULT_GEMINI_VOICE");
  assert.match(ttsRouteSource, /resolveGeminiVoiceId/, "tts-gemini route uses shared resolveGeminiVoiceId");

  // Execute the real POST /api/videos/tts-gemini handler and inspect the exact voice sent to Google TTS.
  const files = new Map<string, Buffer>();
  const requestedVoices: string[] = [];
  const fakeFetch = (async (url: string, options: { body: string }) => {
    const body = JSON.parse(options.body) as {
      generationConfig?: { speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } } } };
    };
    const sentVoice = body.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName ?? "";
    requestedVoices.push(sentVoice);
    const model = url.split("/models/")[1].split(":")[0];
    const pcm = pcmSamples(24000);
    const bytes = model === "gemini-2.5-flash-preview-tts" ? pcm : wav(pcm, RATE);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                mimeType: model === "gemini-2.5-flash-preview-tts" ? `audio/L16;rate=${RATE}` : "audio/wav",
                data: bytes.toString("base64"),
              },
            }],
          },
        }],
      }),
    };
  }) as unknown as typeof UndiciFetch;

  const filename = "src/app/api/videos/tts-gemini/route.ts";
  const mocks: Record<string, Record<string, unknown>> = {
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    fs: {
      default: {
        mkdirSync: () => {},
        existsSync: (p: string) => files.has(p),
        statSync: (p: string) => ({ size: files.get(p)!.length }),
        writeFileSync: (p: string, bytes: Buffer) => { files.set(p, Buffer.from(bytes)); },
        unlinkSync: (p: string) => { files.delete(p); },
      },
    },
    child_process: {
      execFile: (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null, out: string, errout: string) => void) => cb(null, "", ""),
    },
    "@/lib/ffmpeg-path": { getFfmpegPath: () => "inert-ffmpeg" },
    "@/lib/clerk-auth": { getCurrentUser: async () => ({ id: "voice-test-user" }) },
    "@/lib/prisma": { prisma: { user: { findUnique: async () => ({ email: "user@example.invalid", plan: "PRO" }) } } },
    "@/lib/api-error": { apiError: ({ error }: { error: unknown }) => { throw error; } },
    "@/lib/gemini-key": { resolveGeminiKey: () => ({ key: "synthetic", mode: "byok" }), KeyRequiredError: class extends Error {} },
    "@/lib/minute-limits": { checkMinuteQuota: async () => ({ allowed: true }), reserveMinutes: () => { throw new Error("unexpected"); } },
    "@/lib/ai-spend-limits": {
      reserveAiAudioMinutes: async () => ({ allowed: true }),
      refundAiAudioMinutes: async () => {},
      reconcileAiAudioMinutes: async () => {},
      estimateTtsAudioMinutes: () => 1,
    },
    "@/lib/mcp/video-job-funding": { walletFundingForCurrentRequest: () => { throw new Error("unexpected"); } },
    "@/lib/telemetry": { recordTelemetryEvent: async () => {} },
    "@/lib/internal-ai-access": { isInternalAiBetaEnabledFor: internal.isInternalAiBetaEnabledFor },
    "@/lib/gemini-tts-provider.server": {
      ...provider,
      callGeminiTts: (...args: Parameters<typeof provider.callGeminiTts>) => {
        args[5] = { fetch: fakeFetch, sleep: async () => { throw new Error("unexpected retry"); } };
        return provider.callGeminiTts(...args);
      },
    },
  };
  const real = new Set([
    "gemini-voices", "tts-minute-admission", "gemini-errors",
    "gemini-voice-styles", "pcm-tail-fade", "tts-timing",
    "thai-loanwords", "thai-compounds", "voice-preview-cache",
  ]);
  const bundle = await build({
    entryPoints: [filename],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [{
      name: "inert-io",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path: specifier }) => {
          if (specifier in mocks) return { path: specifier, namespace: "fixture" };
          if (specifier.startsWith("@/lib/")) {
            assert.ok(real.has(specifier.slice(6)), `Unexpected dependency: ${specifier}`);
            return { path: path.resolve("src/lib", `${specifier.slice(6)}.ts`) };
          }
        });
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: specifier }) => ({
          contents: Object.keys(mocks[specifier]).map((name) => (
            name === "default"
              ? `export default fixtures[${JSON.stringify(specifier)}].default;`
              : `export const ${name} = fixtures[${JSON.stringify(specifier)}][${JSON.stringify(name)}];`
          )).join("\n"),
        }));
      },
    }],
  });
  let now = Date.now();
  const subject = { exports: {} as { POST: (req: Request) => Promise<Response> } };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module: subject,
    exports: subject.exports,
    require: createRequire(path.resolve(filename)),
    fixtures: mocks,
    process: { env: {}, cwd: () => "/synthetic" },
    Buffer,
    console,
    Date: class extends Date { static now() { return now++; } },
  });

  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ text: "hello default" }, "Aoede", "missing voiceName defaults to Aoede"],
    [{ text: "hello empty", voiceName: "" }, "Aoede", "empty voiceName defaults to Aoede"],
    [{ text: "hello unknown", voiceName: "NotARealVoice" }, "Aoede", "unknown voiceName defaults to Aoede"],
    [{ text: "hello leda", voiceName: "Leda" }, "Leda", "valid voiceName Leda is preserved"],
  ];
  for (const [body, expectedVoice, label] of cases) {
    requestedVoices.length = 0;
    const res = await subject.exports.POST(new Request("http://fixture/api/videos/tts-gemini", {
      method: "POST",
      body: JSON.stringify(body),
    }));
    assert.equal(res.status, 200, `${label}: HTTP 200`);
    assert.equal(requestedVoices[0], expectedVoice, `${label}: provider receives ${expectedVoice}`);
  }
}

async function verifyReloadRacesAndPersistence(): Promise<void> {
  // 1) accountDefaults (Puck) resolves BEFORE server project draft (Leda) finishes loading.
  {
    const projectGet = deferred<ResponseLike>();
    const harness = createHarness({
      search: "?projectId=proj-before",
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    harness.fetchMock.enqueue("GET", "/api/editor-projects/proj-before", projectGet.promise);
    harness.runner.mount();
    await settle(harness.runner);
    // /api/user/video-settings has already resolved with Puck while GET is still pending.
    assert.equal(
      harness.fetchMock.calls.some((c) => c.url === "/api/user/video-settings"),
      true,
      "video-settings resolved before project GET",
    );
    assert.equal(
      harness.runner.current.geminiVoiceName,
      "Aoede",
      "account default Puck must not overwrite state while existing project is still loading",
    );

    projectGet.resolve(response(200, {
      project: {
        id: "proj-before",
        draftRevision: 2,
        status: "draft",
        draft: { script: "saved clip", voiceEngine: "gemini", geminiVoiceName: "Leda" },
      },
    }));
    await settle(harness.runner);
    assert.equal(harness.runner.current.geminiVoiceName, "Leda", "saved Leda survives when accountDefaults arrives first");
    assert.equal(harness.runner.current.voiceEngine, "gemini");
    assert.equal(patchDrafts(harness.fetchMock).length, 0, "reload emits no spurious autosave PATCH");
    harness.runner.unmount();
  }

  // 2) accountDefaults (Puck / elevenlabs) resolves AFTER server project draft (Leda) finishes loading.
  {
    const settingsGet = deferred<ResponseLike>();
    const server = new SharedEditorServer();
    server.setProject("proj-after", 3, {
      script: "saved clip",
      voiceEngine: "gemini",
      geminiVoiceName: "Leda",
    });
    const harness = createHarness({ search: "?projectId=proj-after", server });
    harness.fetchMock.enqueue("GET", "/api/user/video-settings", settingsGet.promise);
    harness.runner.mount();
    await settle(harness.runner);
    assert.equal(harness.runner.current.geminiVoiceName, "Leda");

    settingsGet.resolve(response(200, {
      ttsProvider: "elevenlabs",
      elevenlabsVoiceId: "acc-eleven-id",
      heygenAvatarId: "acc-avatar-id",
      geminiVoiceName: "Puck",
    }));
    await settle(harness.runner);
    assert.equal(harness.runner.current.geminiVoiceName, "Leda", "saved Leda survives when accountDefaults arrives after GET");
    assert.equal(harness.runner.current.voiceEngine, "gemini", "saved voiceEngine survives when accountDefaults arrives after GET");
    assert.equal(harness.runner.current.voiceId, "", "account elevenlabsVoiceId does not overwrite existing project");
    assert.equal(harness.runner.current.avatarId, "", "account heygenAvatarId does not overwrite existing project");
    harness.runner.unmount();
  }

  // 3) Reload via localStorage pointer (no ?projectId= in URL) with account default Puck arriving BEFORE GET.
  {
    const storage = new MemoryStorage();
    storage.setItem("editor-v2-project-id", "stored-leda");
    const projectGet = deferred<ResponseLike>();
    const harness = createHarness({
      storage,
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    harness.fetchMock.enqueue("GET", "/api/editor-projects/stored-leda", projectGet.promise);
    harness.runner.mount();
    await settle(harness.runner);
    projectGet.resolve(response(200, {
      project: {
        id: "stored-leda",
        draftRevision: 1,
        status: "draft",
        draft: { script: "stored pointer clip", voiceEngine: "gemini", geminiVoiceName: "Leda" },
      },
    }));
    await settle(harness.runner);
    assert.equal(harness.runner.current.geminiVoiceName, "Leda", "stored-pointer reload keeps Leda despite Puck account default");
    harness.runner.unmount();
  }

  // 4) Legacy local draft reload (editor-v2-project in localStorage, no existingProjectId)
  //    when /api/user/video-settings returns Puck immediately before ensureServerProject's microtask.
  {
    for (const variant of [
      {
        label: "legacy local draft with Leda",
        localDraft: { script: "local clip", voiceEngine: "gemini", geminiVoiceName: "Leda" },
        expectedVoice: "Leda",
      },
      {
        label: "legacy local draft without geminiVoiceName",
        localDraft: { script: "local clip", voiceEngine: "gemini" },
        expectedVoice: "Aoede",
      },
    ]) {
      const storage = new MemoryStorage();
      storage.setItem("editor-v2-project", JSON.stringify(variant.localDraft));
      const server = new SharedEditorServer();
      const harness = createHarness({
        storage,
        server,
        defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
      });
      harness.runner.mount();
      await settle(harness.runner);
      assert.equal(
        harness.runner.current.geminiVoiceName,
        variant.expectedVoice,
        `${variant.label}: immediate video-settings Puck never overwrites local draft`,
      );
      harness.runner.unmount();
    }
  }

  // 5) Saved project with unset/empty geminiVoiceName reloads to Aoede (NOT account default Puck).
  {
    for (const draft of [
      { script: "legacy no voice", voiceEngine: "gemini" },
      { script: "empty voice", voiceEngine: "gemini", geminiVoiceName: "" },
    ]) {
      const server = new SharedEditorServer();
      server.setProject("proj-unset", 2, draft);
      const harness = createHarness({
        search: "?projectId=proj-unset",
        server,
        defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
      });
      harness.runner.mount();
      await settle(harness.runner);
      assert.equal(harness.runner.current.geminiVoiceName, "Aoede", "unset/empty saved project voice resolves to Aoede, not Puck");
      assert.equal(resolveGeminiVoice(harness.runner.current.geminiVoiceName).id, "Aoede");
      harness.runner.unmount();
    }
  }

  // 6) Edit voice to Leda → persist → reload AND rapid reload before debounce (recovery journal) with account default Puck.
  {
    const server = new SharedEditorServer();
    server.setProject("proj-persist", 1, { script: "clip", voiceEngine: "gemini", geminiVoiceName: "Kore" });
    const storage = new MemoryStorage();

    // Edit to Leda and let debounced autosave persist.
    const first = createHarness({
      search: "?projectId=proj-persist",
      storage,
      server,
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    first.runner.mount();
    await settle(first.runner);
    assert.equal(first.runner.current.geminiVoiceName, "Kore");
    first.runner.current.setGeminiVoiceName("Leda");
    first.runner.flush();
    first.clock.advance(1_000);
    await settle(first.runner);
    assert.equal((server.read("proj-persist")?.draft as JsonRecord).geminiVoiceName, "Leda");
    first.runner.unmount();

    // Reload with slow project GET (account default Puck arrives first).
    const slowGet = deferred<ResponseLike>();
    const second = createHarness({
      search: "?projectId=proj-persist",
      storage,
      server,
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    second.fetchMock.enqueue("GET", "/api/editor-projects/proj-persist", slowGet.promise);
    second.runner.mount();
    await settle(second.runner);
    slowGet.resolve(response(200, { project: server.read("proj-persist") }));
    await settle(second.runner);
    assert.equal(second.runner.current.geminiVoiceName, "Leda", "persisted Leda survives reload with Puck account default");

    // Mutate to Zephyr and reload BEFORE debounce (via synchronous recovery journal).
    second.runner.current.setGeminiVoiceName("Zephyr");
    second.runner.flush();
    second.runner.unmount();

    const third = createHarness({
      search: "?projectId=proj-persist",
      storage,
      server,
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    third.runner.mount();
    await settle(third.runner);
    assert.equal(third.runner.current.geminiVoiceName, "Zephyr", "unflushed voice mutation survives reload via recovery journal");
    third.clock.advance(1_000);
    await settle(third.runner);
    assert.equal((server.read("proj-persist")?.draft as JsonRecord).geminiVoiceName, "Zephyr");
    third.runner.unmount();
  }

  // 7) Switching between projects (Kore → Leda) never resets to account default Puck.
  {
    const server = new SharedEditorServer();
    server.setProject("proj-a", 1, { script: "A", voiceEngine: "gemini", geminiVoiceName: "Kore" });
    server.setProject("proj-b", 1, { script: "B", voiceEngine: "gemini", geminiVoiceName: "Leda" });
    const storage = new MemoryStorage();

    const a = createHarness({
      search: "?projectId=proj-a",
      storage,
      server,
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    a.runner.mount();
    await settle(a.runner);
    assert.equal(a.runner.current.geminiVoiceName, "Kore");
    a.runner.unmount();

    const b = createHarness({
      search: "?projectId=proj-b",
      storage,
      server,
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    b.runner.mount();
    await settle(b.runner);
    assert.equal(b.runner.current.geminiVoiceName, "Leda", "switching to project B preserves Leda");
    b.runner.unmount();
  }

  // 8) Pinning a Brand Profile on a brand-new project locks out late video-settings / fetchMe defaults.
  {
    const lateSettings = deferred<ResponseLike>();
    const lateMe = deferred<JsonRecord | null>();
    const server = new SharedEditorServer();
    const harness = createHarness({
      server,
      fetchMe: lateMe.promise,
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    // First GET /api/user/video-settings goes to Effect E (deferred);
    // second goes to ensureServerProject's loadAccountVideoDefaults() (resolves immediately).
    harness.fetchMock.enqueue("GET", "/api/user/video-settings", lateSettings.promise);
    harness.fetchMock.enqueue("GET", "/api/user/video-settings", response(200, {
      ttsProvider: "gemini",
      geminiVoiceName: "Puck",
    }));
    harness.runner.mount();
    await settle(harness.runner);
    // Resolve fetchMe once so blank bootstrap finishes creating the project.
    lateMe.resolve({ id: "user-1", role: "USER", plan: "PRO", recommendedAutoMixDefault: false });
    await settle(harness.runner);
    const createdId = harness.runner.current.projectId!;
    assert.ok(createdId, "brand-new project created");
    assert.equal(harness.runner.current.geminiVoiceName, "Puck", "brand-new project starts with account default Puck");

    // User pins a Brand Profile with voice Leda and stock-only mix preset.
    const accepted = harness.runner.current.acceptAuthoritativeProjectSnapshot({
      id: createdId,
      draftRevision: 1,
      status: "draft",
      draft: {
        script: "",
        voiceEngine: "gemini",
        geminiVoiceName: "Leda",
        mixPreset: "free",
        brollSource: "stock",
      },
    });
    harness.runner.flush();
    assert.equal(accepted, true);
    assert.equal(harness.runner.current.geminiVoiceName, "Leda");

    // Late Effect E video-settings resolves AFTER the Brand pin.
    lateSettings.resolve(response(200, {
      ttsProvider: "elevenlabs",
      elevenlabsVoiceId: "late-el",
      heygenAvatarId: "late-av",
      geminiVoiceName: "Puck",
    }));
    await settle(harness.runner);
    assert.equal(harness.runner.current.geminiVoiceName, "Leda", "late video-settings cannot overwrite Brand-pinned Leda");
    assert.equal(harness.runner.current.voiceEngine, "gemini");
    assert.equal(harness.runner.current.avatarId, "", "late video-settings cannot inject account avatar after Brand pin");
    harness.runner.unmount();
  }

  // 9) Brand-new project with NO saved draft still receives account default cleanly (and Aoede when unset).
  {
    const server = new SharedEditorServer();
    const withPuck = createHarness({
      server,
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    withPuck.runner.mount();
    await settle(withPuck.runner);
    assert.equal(withPuck.runner.current.geminiVoiceName, "Puck", "brand-new project inherits account default Puck");
    assert.equal(postDrafts(withPuck.fetchMock)[0]?.geminiVoiceName, "Puck", "brand-new project persists Puck to server");
    withPuck.runner.unmount();

    const withUnset = createHarness({
      server: new SharedEditorServer(),
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "" },
    });
    withUnset.runner.mount();
    await settle(withUnset.runner);
    assert.equal(withUnset.runner.current.geminiVoiceName, "Aoede", "brand-new project with unset account default falls back to Aoede");
    assert.equal(postDrafts(withUnset.fetchMock)[0]?.geminiVoiceName, "Aoede");
    withUnset.runner.unmount();
  }

  // 10) Creating a new project via resetProject() from an existing Leda project inherits account default Puck.
  {
    const server = new SharedEditorServer();
    server.setProject("existing-leda", 2, { script: "old", voiceEngine: "gemini", geminiVoiceName: "Leda" });
    const harness = createHarness({
      search: "?projectId=existing-leda",
      server,
      defaultVideoSettings: { ttsProvider: "gemini", geminiVoiceName: "Puck" },
    });
    harness.runner.mount();
    await settle(harness.runner);
    assert.equal(harness.runner.current.geminiVoiceName, "Leda");

    const nextId = await harness.runner.current.resetProject();
    await settle(harness.runner);
    assert.ok(nextId && nextId !== "existing-leda");
    assert.equal(harness.runner.current.geminiVoiceName, "Puck", "new project via resetProject inherits account default Puck");
    assert.equal(postDrafts(harness.fetchMock).at(-1)?.geminiVoiceName, "Puck");
    harness.runner.unmount();
  }
}

async function main(): Promise<void> {
  await verifySharedDefaultAndTtsRoute();
  await verifyReloadRacesAndPersistence();
  console.log("verify-voice-picker-persistence: PASS shared Aoede default across UI/TTS, reload races eliminated, new-project account defaults preserved");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
