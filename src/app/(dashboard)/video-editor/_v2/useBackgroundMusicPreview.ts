"use client";

import { useEffect, useRef, type RefObject } from "react";
import { startPlayback } from "@/lib/media-playback";
import {
  bgmGainAt,
  loopedPositionSec,
  nextPreviewListenerIntent,
  normalizeObservedVideoListenerIntent,
  previewListenerLevel,
  previewSrcForTrack,
  type BackgroundMusicEdit,
  type PreviewListenerIntent,
  type SpeechSegment,
} from "@/lib/background-music";

/**
 * EP5 U7 (HERO-71): hear a changed background music in the Post-phase preview without a server
 * render. The preview video has voice + the OLD music baked in, so while a change is active the
 * video is muted and the voice track plus the new music play beside it, slaved to the video
 * clock (play / pause / seek / rate, drift > 0.25 s corrected). The music gain follows the same
 * envelope the burn uses (`bgmGainAt`), so ducking is audible here too. Volume / ducking changes
 * apply on the next frame without rebuilding anything. No change (`music` undefined) = this hook
 * does nothing and the video plays its own audio exactly as before.
 *
 * The music goes through a Web Audio GainNode because iOS ignores `HTMLMediaElement.volume`
 * (`/api/music/*` is same-origin, so the graph is not silenced by CORS). The voice is a plain
 * element — it may live on another origin, which a media-element source would silence. If the
 * browser refuses to start audio (autoplay policy), the video is unmuted so the creator still
 * hears the voice, and the next tap / key press tries again. If the voice track itself cannot be
 * played (load error, or it never buffers while the video plays), the video's own audio comes
 * back for good: an old-music preview beats a silent one (ticket cmv4r0v6u — an imported
 * presenter served 403 and the whole preview went quiet).
 *
 * The video stays muted while a change is active, so its native mute / volume controls are read
 * as the creator's intent (`nextPreviewListenerIntent`) and applied to the voice and the music.
 */

const DRIFT_SEC = 0.25;
const RETRY_AFTER_ERROR_MS = 1_000;
/** How long the voice may sit unbuffered while the video plays before the preview gives up on it. */
const VOICE_STALL_MS = 5_000;
/** HTMLMediaElement.HAVE_FUTURE_DATA: enough buffered to keep playing. */
const HAVE_FUTURE_DATA = 3;
const VOLUME_EPSILON = 1e-4;

type AudioContextCtor = typeof AudioContext;

function setMediaVolume(media: HTMLMediaElement, volume: number) {
  const clamped = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
  if (Math.abs(media.volume - clamped) <= VOLUME_EPSILON) return;
  try {
    media.volume = clamped;
  } catch {
    // read-only volume (e.g. iOS Safari)
  }
}

export function useBackgroundMusicPreview({
  videoRef,
  music,
  voiceSrc,
  segments,
  listenerIntent,
  onListenerIntentChange,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The changed music; undefined = no change (the video keeps its own audio). */
  music: BackgroundMusicEdit | undefined;
  /** The voice-only track under the base mix. Null = a change cannot be previewed. */
  voiceSrc: string | null;
  segments: readonly SpeechSegment[];
  /** Explicit preview mute/volume intent from the editor's sound controls (Desktop + Mobile). */
  listenerIntent?: PreviewListenerIntent;
  /** Notified when native `<video>` controls update the creator's mute/volume intent. */
  onListenerIntentChange?: (next: PreviewListenerIntent) => void;
}) {
  // Volume / ducking / timing read by the frame loop without restarting the players.
  const liveRef = useRef({ music, segments, listenerIntent, onListenerIntentChange });
  const applyExternalIntentRef = useRef<((next: PreviewListenerIntent) => void) | null>(null);
  useEffect(() => {
    liveRef.current = { music, segments, listenerIntent, onListenerIntentChange };
  }, [music, segments, listenerIntent, onListenerIntentChange]);
  const active = !!music && !!voiceSrc;
  const bgmSrc = active ? previewSrcForTrack(music?.track) : null;

  useEffect(() => {
    if (!active || !voiceSrc || typeof window === "undefined") return;
    const voice = new Audio();
    voice.preload = "auto";
    voice.src = voiceSrc;
    const bgm = bgmSrc ? new Audio() : null;
    if (bgm && bgmSrc) {
      bgm.preload = "auto";
      bgm.loop = true;
      bgm.src = bgmSrc;
    }
    let ctx: AudioContext | null = null;
    let gain: GainNode | null = null;
    if (bgm) {
      try {
        const Ctor = window.AudioContext
          ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
        if (Ctor) {
          ctx = new Ctor();
          gain = ctx.createGain();
          ctx.createMediaElementSource(bgm).connect(gain);
          gain.connect(ctx.destination);
        }
      } catch {
        ctx = null;
        gain = null;
      }
    }

    let video: HTMLVideoElement | null = null;
    let intent: PreviewListenerIntent = liveRef.current.listenerIntent
      ? { ...liveRef.current.listenerIntent }
      : { muted: false, volume: 1 };
    let lastVideoVolume = 1;
    let holdingVideoMuted = false;
    let blocked = false;
    let voiceFailed = false;
    let stalledSince = 0;
    let errorAt = 0;
    const onVoiceError = () => {
      voiceFailed = true;
    };
    voice.addEventListener("error", onVoiceError);
    const onVolumeChange = () => {
      if (!video) return;
      const observedVolume = video.volume;
      const observed = normalizeObservedVideoListenerIntent({
        current: intent,
        observedMuted: video.muted,
        observedVolume,
        lastVideoVolume,
      });
      lastVideoVolume = observedVolume;
      const next = !holdingVideoMuted && (blocked || voiceFailed)
        ? observed
        : nextPreviewListenerIntent(intent, observed);
      if (next.muted !== intent.muted || Math.abs(next.volume - intent.volume) > VOLUME_EPSILON) {
        intent = next;
        liveRef.current.onListenerIntentChange?.(next);
      }
    };
    const elements = bgm ? [voice, bgm] : [voice];
    const primed = new WeakSet<HTMLAudioElement>();
    const priming = new Set<HTMLAudioElement>();

    const attach = (next: HTMLVideoElement | null) => {
      if (video === next) return;
      if (video) {
        video.removeEventListener("volumechange", onVolumeChange);
        video.muted = intent.muted;
        setMediaVolume(video, intent.volume);
      }
      video = next;
      holdingVideoMuted = false;
      if (video) {
        if (liveRef.current.listenerIntent) {
          intent = { ...liveRef.current.listenerIntent };
          setMediaVolume(video, intent.volume);
        } else {
          intent = { muted: video.muted, volume: video.volume };
        }
        lastVideoVolume = video.volume;
        video.addEventListener("volumechange", onVolumeChange);
      }
    };
    const pauseAll = () => {
      for (const el of elements) if (!el.paused) el.pause();
    };
    const start = (el: HTMLAudioElement) => {
      if (Date.now() - errorAt < RETRY_AFTER_ERROR_MS) return;
      el.play().catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name === "NotAllowedError") blocked = true;
        else errorAt = Date.now();
      });
    };
    const align = (el: HTMLAudioElement, target: number) => {
      if (Math.abs(el.currentTime - target) <= DRIFT_SEC) return;
      try {
        el.currentTime = target;
      } catch {
        // not seekable yet — the next frame tries again
      }
    };
    const setGain = (value: number) => {
      if (gain) gain.gain.value = value;
      else if (bgm) {
        if (!priming.has(bgm) && bgm.muted !== (value === 0)) bgm.muted = value === 0;
        try {
          bgm.volume = value;
        } catch {
          // read-only volume (iOS without Web Audio): muted still silences when value === 0
        }
      }
    };
    const applyListenerLevel = (t: number) => {
      const level = previewListenerLevel(intent);
      // iOS ignores element.volume but honours muted, so a mute there still silences the voice.
      if (!priming.has(voice) && voice.muted !== (level === 0)) voice.muted = level === 0;
      if (voice.volume !== level) voice.volume = level;
      const live = liveRef.current;
      if (live.music) {
        setGain(bgmGainAt(t * 1000, {
          volume: live.music.volume,
          ducking: live.music.ducking,
          segments: live.segments,
        }) * level);
      } else if (level === 0) {
        setGain(0);
      }
    };

    applyExternalIntentRef.current = (next: PreviewListenerIntent) => {
      intent = { muted: next.muted, volume: next.volume };
      if (video) {
        setMediaVolume(video, intent.volume);
        lastVideoVolume = video.volume;
        if (blocked || voiceFailed) {
          video.muted = intent.muted;
          holdingVideoMuted = false;
        }
      }
      applyListenerLevel(video ? video.currentTime : 0);
    };

    // A real tap / key press lets the browser start audio: resume the graph and unlock each
    // element with a silent play (iOS needs one per element), then let the frame loop take over.
    const onGesture = () => {
      blocked = false;
      void ctx?.resume().catch(() => {});
      for (const el of elements) {
        if (primed.has(el) || !el.paused) continue;
        primed.add(el);
        priming.add(el);
        el.muted = true;
        void startPlayback(el).then((started) => {
          if (started) el.pause();
          el.muted = el === voice ? previewListenerLevel(intent) === 0 : false;
          priming.delete(el);
        });
      }
    };
    document.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("keydown", onGesture, true);

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      attach(videoRef.current);
      const v = video;
      const live = liveRef.current;
      if (!v || !live.music) return;
      if (blocked || voiceFailed) {
        // Never leave the creator with a silent preview: fall back to the video's own audio.
        v.muted = intent.muted;
        setMediaVolume(v, intent.volume);
        lastVideoVolume = v.volume;
        holdingVideoMuted = false;
        pauseAll();
        return;
      }
      holdingVideoMuted = true;
      v.muted = true;
      const t = v.currentTime;
      const rate = v.playbackRate || 1;
      applyListenerLevel(t);
      for (const el of elements) if (el.playbackRate !== rate) el.playbackRate = rate;
      const voiceDone = Number.isFinite(voice.duration) && t >= voice.duration - 0.05;
      if (!voiceDone) align(voice, t);
      if (bgm && Number.isFinite(bgm.duration)) align(bgm, loopedPositionSec(t, bgm.duration));
      const playingNow = !v.paused && !v.ended;
      if (!playingNow) {
        stalledSince = 0;
        pauseAll();
        return;
      }
      if (!voiceDone && voice.readyState < HAVE_FUTURE_DATA) {
        if (!stalledSince) stalledSince = Date.now();
        else if (Date.now() - stalledSince > VOICE_STALL_MS) voiceFailed = true;
      } else {
        stalledSince = 0;
      }
      if (voice.paused && !voiceDone) start(voice);
      if (voiceDone && !voice.paused) voice.pause();
      if (bgm?.paused) start(bgm);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      applyExternalIntentRef.current = null;
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
      voice.removeEventListener("error", onVoiceError);
      attach(null);
      for (const el of elements) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      void ctx?.close().catch(() => {});
    };
  }, [active, bgmSrc, voiceSrc, videoRef]);

  const listenerMuted = listenerIntent?.muted;
  const listenerVolume = listenerIntent?.volume;
  useEffect(() => {
    if (listenerMuted === undefined || listenerVolume === undefined) return;
    applyExternalIntentRef.current?.({ muted: listenerMuted, volume: listenerVolume });
  }, [listenerMuted, listenerVolume, active, bgmSrc, voiceSrc]);
}
