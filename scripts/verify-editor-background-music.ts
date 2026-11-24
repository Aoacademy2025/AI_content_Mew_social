// EP5 U7 + #2 (HERO-71), web half: the v2 Post phase music picker + volume + ducking, heard in
// the browser preview, carried into Burn & Download, and kept in the project draft.
// Pure helpers run for real; the hook / component wiring is checked against the source (the
// repo's pattern for editor files that need a browser to execute).
//   tsx scripts/verify-editor-background-music.ts
import { readFileSync } from "node:fs";

import {
  applyObservedPreviewAudio,
  backgroundMusicTrackPath,
  baseBackgroundMusicEdit,
  bgmGainAt,
  DEFAULT_BGM_VOLUME,
  DEFAULT_PREVIEW_AUDIO_STATE,
  DUCK_RATIO,
  loopedPositionSec,
  nextPreviewListenerIntent,
  normalizeBackgroundMusicEdit,
  normalizeObservedVideoListenerIntent,
  previewListenerLevel,
  setPreviewAudioVolume,
  speechSegments,
  togglePreviewAudioMute,
} from "../src/lib/background-music";
import { normalizeWebPendingEdit } from "../src/app/(dashboard)/video-editor/_v2/pending-edit-view";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` -- ${JSON.stringify(detail)}`}`);
  }
}
function read(path: string) {
  return readFileSync(path, "utf8");
}
const V2 = "src/app/(dashboard)/video-editor/_v2";

console.log("W1) library selection -> draft track path");
check("system pick -> /music/<f>", backgroundMusicTrackPath("calm.mp3", "system") === "/music/calm.mp3");
check("own upload -> /api/music/<f>", backgroundMusicTrackPath("u-1.mp3", "user") === "/api/music/u-1.mp3");
check("path traversal refused", backgroundMusicTrackPath("../x.mp3", "system") === null);
check("nested path refused", backgroundMusicTrackPath("a/b.mp3", "user") === null);
check("empty refused", backgroundMusicTrackPath("", "system") === null);
check(
  "every produced path passes the shared draft validator",
  normalizeBackgroundMusicEdit({ track: backgroundMusicTrackPath("calm.mp3", "system"), volume: 0.3, ducking: true }) !== null,
);

console.log("W2) the rendered video's own music (what the panel shows before any change)");
{
  const base = baseBackgroundMusicEdit({ bgmFile: "/music/calm.mp3", bgmVolume: 0.2 });
  check("base track + volume, ducking off", base.edit.track === "/music/calm.mp3" && base.edit.volume === 0.2 && base.edit.ducking === false && base.hasMusic);
  const noMusic = baseBackgroundMusicEdit({});
  check("no music -> track null, default volume", noMusic.edit.track === null && noMusic.edit.volume === DEFAULT_BGM_VOLUME && !noMusic.hasMusic);
  const legacy = baseBackgroundMusicEdit({ bgmFile: "https://cdn.example/x.mp3" });
  check("unrecognised base path -> has music, but not a pickable track", legacy.hasMusic && legacy.edit.track === null);
  const bad = baseBackgroundMusicEdit({ bgmFile: "/music/a.mp3", bgmVolume: 7 });
  check("base volume clamped", bad.edit.volume === 1);
  check("null config tolerated", baseBackgroundMusicEdit(null).edit.track === null);
}

console.log("W3) preview math (same envelope as the burn)");
{
  check("music loops like Remotion <Audio loop>", loopedPositionSec(75, 30) === 15);
  check("before the end -> unchanged", loopedPositionSec(12.5, 30) === 12.5);
  check("unknown duration -> unchanged", loopedPositionSec(12.5, Number.NaN) === 12.5);
  check("zero duration -> 0", loopedPositionSec(12.5, 0) === 0);
  const segments = speechSegments({ captions: [{ startMs: 1000, endMs: 2000 }] });
  check("ducked mid-speech", Math.abs(bgmGainAt(1500, { volume: 0.4, ducking: true, segments }) - 0.4 * DUCK_RATIO) < 1e-9);
  check("full volume in silence", bgmGainAt(5000, { volume: 0.4, ducking: true, segments }) === 0.4);
}

console.log("W4) the agent's pending music reaches the web editor");
{
  const pending = normalizeWebPendingEdit({
    revision: 3,
    baseJobId: "job-1",
    draft: {
      captions: [{ text: "a", startMs: 0, endMs: 1000 }],
      originalCaptions: [{ text: "a", startMs: 0, endMs: 1000 }],
      subtitleConfig: {},
      cardLen: "sentence",
      captionOverrides: {},
      backgroundMusic: { track: "/music/calm.mp3", volume: 0.3, ducking: true },
    },
  });
  check("pending draft carries backgroundMusic", pending?.draft.backgroundMusic?.track === "/music/calm.mp3", pending?.draft);
  const forged = normalizeWebPendingEdit({
    revision: 3,
    baseJobId: "job-1",
    draft: {
      captions: [{ text: "a", startMs: 0, endMs: 1000 }],
      originalCaptions: [{ text: "a", startMs: 0, endMs: 1000 }],
      subtitleConfig: {},
      cardLen: "sentence",
      captionOverrides: {},
      backgroundMusic: { track: "https://evil.example/x.mp3", volume: 0.3 },
    },
  });
  check("an invalid music value is dropped, the rest of the draft survives", !!forged && forged.draft.backgroundMusic === undefined);
}

console.log("W5) project draft (useV2Project) keeps the choice");
{
  const src = read(`${V2}/useV2Project.ts`);
  check("V2Draft declares backgroundMusic", /backgroundMusic\?: BackgroundMusicEdit;/.test(src));
  check("state is a user draft field keyed backgroundMusic", /useUserDraftState<BackgroundMusicEdit \| undefined>\([\s\S]{0,120}"backgroundMusic"/.test(src));
  check("buildDraft writes it only when set (old drafts unchanged)", /\.\.\.\(backgroundMusic \? \{ backgroundMusic \} : \{\}\)/.test(src));
  check("applyDraft re-validates it", /setBackgroundMusicRaw\(normalizeBackgroundMusicEdit\(next\.backgroundMusic\) \?\? undefined\)/.test(src));
  check("a Step-2 music change clears the Post-phase edit", /setMusicTrackStep2[\s\S]{0,200}setBackgroundMusicRaw\(undefined\)/.test(src));
  check("a Step-2 volume change clears the Post-phase edit", /setBgmVolumeStep2[\s\S]{0,200}setBackgroundMusicRaw\(undefined\)/.test(src));
  check("Step 2 gets the clearing setters", /setMusicTrack: setMusicTrackStep2/.test(src) && /setBgmVolume: setBgmVolumeStep2/.test(src));
  check("the hook returns the Post-phase setter", /backgroundMusic, setBackgroundMusic,/.test(src));
}

console.log("W6) Post phase editor -> Burn & Download");
{
  const src = read(`${V2}/usePostPhaseEditor.ts`);
  check(
    "the resync effect follows the agent draft unconditionally (discard clears it)",
    /useEffect\(\(\) => \{\s*if \(!pendingEdit[\s\S]*?setMusicOverrideState\(draft\.backgroundMusic\);[\s\S]*?\}, \[pendingEdit\]\);/.test(src),
  );
  check("export sends backgroundMusic only when the music was changed", /\.\.\.\(exportMusic \? \{ backgroundMusic: exportMusic \} : \{\}\)/.test(src));
  check("export records the burned music in the project draft", /if \(exportMusic\) onBackgroundMusicChange\(exportMusic\)/.test(src));
  check("the live preview hook is wired to the editor's video", /useBackgroundMusicPreview\(\{[\s\S]{0,200}videoRef/.test(src));
  check("a new track turns ducking on by default", /ducking: patch\.ducking \?\? \(isNewTrack \? true : current\.ducking\)/.test(src));
  const job = read(`${V2}/useV2Job.ts`);
  check("useV2Job forwards backgroundMusic in the export body", /\.\.\.\(input\.backgroundMusic \? \{ backgroundMusic: input\.backgroundMusic \} : \{\}\)/.test(job));
}

console.log("W7) preview hook");
{
  const src = read(`${V2}/useBackgroundMusicPreview.ts`);
  check("mutes the baked base audio only while a change is active", /\bv\.muted = true/.test(src) && /v\.muted = intent\.muted/.test(src));
  check("music gain goes through a GainNode (iOS ignores element.volume)", /createGain\(\)/.test(src) && /createMediaElementSource/.test(src));
  check("gain follows the burn's envelope", /bgmGainAt\(/.test(src));
  check("music position loops like the burn", /loopedPositionSec\(/.test(src));
  check("audio elements are released on cleanup", /removeAttribute\("src"\)/.test(src));
}

console.log("W7b) preview never goes silent; the video's own controls still work (ticket cmv4r0v6u)");
{
  const on = { muted: false, volume: 0.8 };
  check("the hook's own re-mute at the same level changes nothing",
    JSON.stringify(nextPreviewListenerIntent(on, { muted: true, volume: 0.8 })) === JSON.stringify(on));
  check("an unmute is the creator's", nextPreviewListenerIntent({ muted: true, volume: 0.8 }, { muted: false, volume: 0.8 }).muted === false);
  check("a new level is the creator's (and means: I want to hear it)",
    JSON.stringify(nextPreviewListenerIntent({ muted: true, volume: 0.8 }, { muted: true, volume: 0.3 })) === JSON.stringify({ muted: false, volume: 0.3 }));
  check("a creator who had muted stays muted across the hook's re-mutes",
    nextPreviewListenerIntent({ muted: true, volume: 0.8 }, { muted: true, volume: 0.8 }).muted === true);
  check("level: muted → 0, else the clamped volume",
    previewListenerLevel({ muted: true, volume: 0.8 }) === 0 && previewListenerLevel({ muted: false, volume: 0.5 }) === 0.5
    && previewListenerLevel({ muted: false, volume: 7 }) === 1 && previewListenerLevel({ muted: false, volume: Number.NaN }) === 1);

  const src = read(`${V2}/useBackgroundMusicPreview.ts`);
  check("a voice track that fails to load falls back to the video's own audio",
    /addEventListener\("error"/.test(src) && /voiceFailed/.test(src) && /if \(blocked \|\| voiceFailed\)/.test(src));
  check("a voice track that never buffers while the video plays also falls back", /VOICE_STALL_MS/.test(src) && /readyState/.test(src));
  check("the video's volumechange is read as the creator's intent", /addEventListener\("volumechange"/.test(src) && /nextPreviewListenerIntent\(/.test(src));
  check("voice and music follow that level", /voice\.volume = level/.test(src) && /\* level/.test(src));
  check("a mute reaches the voice on iOS too (element.volume is read-only there)", /voice\.muted = level === 0/.test(src));
}

console.log("W8) desktop + mobile panels");
{
  const desktop = read(`${V2}/PostPhase.tsx`);
  const mobile = read(`${V2}/PostPhaseMobile.tsx`);
  const controls = read(`${V2}/BackgroundMusicControls.tsx`);
  check("desktop has a music tab rendering the controls", /rightTab === "music"[\s\S]{0,400}<BackgroundMusicControls/.test(desktop));
  check("mobile has a music sheet rendering the controls", /<BackgroundMusicControls/.test(mobile));
  check("controls offer no-music, volume 0-100 and the ducking toggle",
    /ไม่ใส่เพลง/.test(controls) && /max=\{100\}/.test(controls) && /ลดเสียงเพลงตอนพูด/.test(controls));
  check("controls offer a way back to the rendered music", /ใช้เพลงเดิมของคลิป/.test(controls));
}

console.log("W9) preview sound controls on desktop + mobile and BGM mute/unmute intent (HERO-122)");
{
  const initial = DEFAULT_PREVIEW_AUDIO_STATE;
  check("default preview audio starts unmuted at full volume", initial.muted === false && initial.volume === 1 && previewListenerLevel(initial) === 1);

  const lowered = setPreviewAudioVolume(initial, 0.65);
  check("setting volume keeps unmuted and updates lastAudibleVolume", !lowered.muted && lowered.volume === 0.65 && lowered.lastAudibleVolume === 0.65);

  const muted = togglePreviewAudioMute(lowered);
  check("toggling mute silences output while preserving volume for restore", muted.muted === true && muted.volume === 0.65 && previewListenerLevel(muted) === 0);

  const unmuted = togglePreviewAudioMute(muted);
  check("toggling unmute restores previous audible volume", unmuted.muted === false && unmuted.volume === 0.65 && previewListenerLevel(unmuted) === 0.65);

  const draggedZero = setPreviewAudioVolume(lowered, 0);
  check("dragging volume to 0 mutes while keeping lastAudibleVolume", draggedZero.muted === true && draggedZero.volume === 0 && draggedZero.lastAudibleVolume === 0.65);

  const unmutedFromZero = togglePreviewAudioMute(draggedZero);
  check("unmuting from volume 0 restores last audible volume instead of staying silent", unmutedFromZero.muted === false && unmutedFromZero.volume === 0.65);

  const draggedUpWhileMuted = setPreviewAudioVolume(muted, 0.4);
  check("dragging volume above 0 while muted automatically unmutes", draggedUpWhileMuted.muted === false && draggedUpWhileMuted.volume === 0.4);

  const observedZero = applyObservedPreviewAudio(lowered, { muted: false, volume: 0 });
  check("observed native volume=0 maps to muted state", observedZero.muted === true && observedZero.volume === 0 && observedZero.lastAudibleVolume === 0.65);

  const observedUnmuteAtZero = applyObservedPreviewAudio(observedZero, { muted: false, volume: 0 });
  check("observed native unmute from volume 0 restores last audible level", observedUnmuteAtZero.muted === false && observedUnmuteAtZero.volume === 0.65);

  // Explicit mute/unmute intent during active BGM preview (including iOS read-only video.volume === 1)
  const bgmMutedDesktopObserved = normalizeObservedVideoListenerIntent({
    current: { muted: true, volume: 0.6 },
    observedMuted: true,
    observedVolume: 0.6,
    lastVideoVolume: 0.6,
  });
  const bgmMutedDesktop = nextPreviewListenerIntent({ muted: true, volume: 0.6 }, bgmMutedDesktopObserved);
  check("BGM hook re-mute keeps explicit mute intent on desktop", bgmMutedDesktop.muted === true && bgmMutedDesktop.volume === 0.6);

  const bgmMutedIosObserved = normalizeObservedVideoListenerIntent({
    current: { muted: true, volume: 0.6 },
    observedMuted: true,
    observedVolume: 1,
    lastVideoVolume: 1,
  });
  const bgmMutedIos = nextPreviewListenerIntent({ muted: true, volume: 0.6 }, bgmMutedIosObserved);
  check("iOS read-only video.volume=1 does not falsely unmute an explicit mute during BGM preview", bgmMutedIos.muted === true && bgmMutedIos.volume === 0.6);

  const bgmNativeDragObserved = normalizeObservedVideoListenerIntent({
    current: { muted: true, volume: 0.6 },
    observedMuted: true,
    observedVolume: 0.8,
    lastVideoVolume: 0.6,
  });
  const bgmNativeDrag = nextPreviewListenerIntent({ muted: true, volume: 0.6 }, bgmNativeDragObserved);
  check("real desktop native volume drag during BGM preview unmutes to the new volume", bgmNativeDrag.muted === false && bgmNativeDrag.volume === 0.8);

  const bgmHookSrc = read(`${V2}/useBackgroundMusicPreview.ts`);
  const editorSrc = read(`${V2}/usePostPhaseEditor.ts`);
  const desktop = read(`${V2}/PostPhase.tsx`);
  const mobile = read(`${V2}/PostPhaseMobile.tsx`);

  check("useBackgroundMusicPreview accepts explicit listenerIntent, syncs changes back, and guards fallback transitions",
    /listenerIntent\?:\s*PreviewListenerIntent/.test(bgmHookSrc)
    && /onListenerIntentChange\?:/.test(bgmHookSrc)
    && /normalizeObservedVideoListenerIntent\(/.test(bgmHookSrc)
    && /holdingVideoMuted/.test(bgmHookSrc));
  check("usePostPhaseEditor exposes shared preview audio controls synced with BGM preview",
    /previewMuted:\s*previewAudio\.muted/.test(editorSrc)
    && /previewVolume:\s*previewAudio\.volume/.test(editorSrc)
    && /togglePreviewMute/.test(editorSrc)
    && /setPreviewVolume/.test(editorSrc)
    && /listenerIntent:\s*previewListenerIntent/.test(editorSrc));
  check("desktop PostPhase renders accessible mute/unmute button and volume slider beside preview",
    /data-preview-mute-toggle="desktop"/.test(desktop)
    && /data-preview-volume-slider="desktop"/.test(desktop)
    && /Volume2/.test(desktop)
    && /VolumeX/.test(desktop)
    && /ed\.previewMuted \? "เปิดเสียง" : "ปิดเสียง"/.test(desktop)
    && /onVolumeChange=\{\(e\) => ed\.onPreviewVideoVolumeChange\(e\.currentTarget\)\}/.test(desktop));
  check("mobile PostPhaseMobile renders 44x44 accessible mute/unmute button in the transport bar",
    /data-preview-mute-toggle="mobile"/.test(mobile)
    && /Volume2/.test(mobile)
    && /VolumeX/.test(mobile)
    && /ed\.previewMuted \? "เปิดเสียง" : "ปิดเสียง"/.test(mobile)
    && /data-preview-mute-toggle="mobile"[\s\S]{0,600}width:\s*44[\s\S]{0,40}height:\s*44/.test(mobile)
    && /onVolumeChange=\{\(e\) => ed\.onPreviewVideoVolumeChange\(e\.currentTarget\)\}/.test(mobile));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
