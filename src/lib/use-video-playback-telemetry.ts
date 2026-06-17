"use client";

import { useEffect, type RefObject } from "react";
import { trackEvent } from "@/lib/client-telemetry";

type PlaybackTelemetryContext = {
  enabled?: boolean;
  page: "gallery" | "video-editor" | string;
  videoUrl: string | null;
  videoId?: string | null;
  sourceKind?: string | null;
};

type ConnectionInfo = {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
};

type NavigatorWithConnection = Navigator & {
  connection?: ConnectionInfo;
};

const MAX_BUFFER_EVENTS = 6;
const BIND_RETRY_MS = 100;
const BIND_RETRY_COUNT = 20;

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function round(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function roundedSeconds(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function sourceInfo(rawUrl: string | null) {
  if (!rawUrl) return { sourceHost: null, sourcePath: null, sourceRoute: "unknown" };
  try {
    const url = new URL(rawUrl, window.location.origin);
    const sourcePath = url.pathname.slice(0, 220);
    const sourceRoute = sourcePath.startsWith("/api/renders/")
      ? "api_renders"
      : sourcePath.startsWith("/renders/")
        ? "renders"
        : sourcePath.startsWith("/api/stocks/")
          ? "api_stocks"
          : sourcePath.startsWith("/stocks/")
            ? "stocks"
            : url.origin === window.location.origin
              ? "same_origin_other"
              : "external";
    return { sourceHost: url.host, sourcePath, sourceRoute };
  } catch {
    return { sourceHost: null, sourcePath: rawUrl.slice(0, 220), sourceRoute: "invalid" };
  }
}

function connectionInfo() {
  const connection = (navigator as NavigatorWithConnection).connection;
  return {
    effectiveType: connection?.effectiveType ?? null,
    downlinkMbps: typeof connection?.downlink === "number" ? connection.downlink : null,
    rttMs: typeof connection?.rtt === "number" ? connection.rtt : null,
    saveData: typeof connection?.saveData === "boolean" ? connection.saveData : null,
  };
}

function bufferedEndSeconds(video: HTMLVideoElement) {
  let end = 0;
  for (let i = 0; i < video.buffered.length; i += 1) {
    end = Math.max(end, video.buffered.end(i));
  }
  return roundedSeconds(end);
}

function mediaErrorMessage(video: HTMLVideoElement) {
  if (!video.error) return null;
  const messages: Record<number, string> = {
    1: "aborted",
    2: "network",
    3: "decode",
    4: "source_not_supported",
  };
  return messages[video.error.code] ?? video.error.message ?? "unknown";
}

export function useVideoPlaybackTelemetry(
  videoRef: RefObject<HTMLVideoElement | null>,
  context: PlaybackTelemetryContext,
) {
  const {
    enabled = true,
    page,
    videoUrl,
    videoId = null,
    sourceKind = null,
  } = context;

  useEffect(() => {
    if (!enabled || !videoUrl) return;

    let cancelled = false;
    let retryTimer: number | null = null;
    let cleanupTelemetry: (() => void) | null = null;
    let bindAttempts = 0;

    const bindToVideo = (video: HTMLVideoElement) => {
      const sessionStartedAt = nowMs();
      const source = sourceInfo(video.currentSrc || video.src || videoUrl);
      let loadStartedAt: number | null = null;
      let playRequestedAt: number | null = null;
      let waitingStartedAt: number | null = null;
      let metadataSent = false;
      let canPlaySent = false;
      let firstFrameSent = false;
      let playEvents = 0;
      let waitingCount = 0;
      let stalledCount = 0;
      let seekCount = 0;

      const baseProperties = () => ({
        page,
        videoId,
        sourceKind,
        sourceHost: source.sourceHost,
        sourcePath: source.sourcePath,
        sourceRoute: source.sourceRoute,
        readyState: video.readyState,
        networkState: video.networkState,
        durationSec: roundedSeconds(video.duration),
        currentSec: roundedSeconds(video.currentTime),
        bufferedEndSec: bufferedEndSeconds(video),
        videoWidth: video.videoWidth || null,
        videoHeight: video.videoHeight || null,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        ...connectionInfo(),
      });

      const emit = (
        name: string,
        status: "started" | "done" | "error" | "running" | "info",
        extra: Record<string, unknown> = {},
        durationMs?: number | null,
      ) => {
        trackEvent(name, {
          category: "performance",
          path: window.location.pathname,
          status,
          durationMs: durationMs ?? undefined,
          value: extra.value as number | undefined,
          properties: {
            ...baseProperties(),
            ...extra,
          },
        });
      };

      emit("video_playback_session_started", "started", {
        autoplay: video.autoplay,
        muted: video.muted,
        preload: video.preload || null,
        bindAttempts,
      });

      const onLoadStart = () => {
        loadStartedAt = nowMs();
        emit("video_playback_load_started", "started");
      };

      const onLoadedMetadata = () => {
        if (metadataSent) return;
        metadataSent = true;
        emit(
          "video_playback_metadata_loaded",
          "done",
          {},
          nowMs() - (loadStartedAt ?? sessionStartedAt),
        );
      };

      const onCanPlay = () => {
        if (canPlaySent) return;
        canPlaySent = true;
        emit(
          "video_playback_canplay",
          "done",
          {},
          nowMs() - (loadStartedAt ?? sessionStartedAt),
        );
      };

      const onPlay = () => {
        playRequestedAt = nowMs();
        playEvents += 1;
        if (playEvents <= 4) {
          emit("video_playback_play_requested", "started", { playEvents });
        }
      };

      const onPlaying = () => {
        const current = nowMs();
        if (waitingStartedAt != null) {
          emit(
            "video_playback_recovered",
            "done",
            { waitingCount },
            current - waitingStartedAt,
          );
          waitingStartedAt = null;
        }

        if (firstFrameSent) return;
        firstFrameSent = true;
        emit(
          "video_playback_first_frame",
          "done",
          {
            startupFromPlayMs: round(current - (playRequestedAt ?? sessionStartedAt)),
            startupFromLoadMs: round(current - (loadStartedAt ?? sessionStartedAt)),
          },
          current - (playRequestedAt ?? sessionStartedAt),
        );
      };

      const onWaiting = () => {
        waitingCount += 1;
        waitingStartedAt = nowMs();
        if (waitingCount <= MAX_BUFFER_EVENTS) {
          emit("video_playback_waiting", "running", { waitingCount });
        }
      };

      const onStalled = () => {
        stalledCount += 1;
        if (stalledCount <= MAX_BUFFER_EVENTS) {
          emit("video_playback_stalled", "running", { stalledCount });
        }
      };

      const onSeeking = () => {
        seekCount += 1;
      };

      const onError = () => {
        emit("video_playback_error", "error", {
          errorCode: video.error?.code ?? null,
          errorMessage: mediaErrorMessage(video),
        });
      };

      const onEnded = () => {
        emit(
          "video_playback_ended",
          "done",
          { waitingCount, stalledCount, seekCount },
          nowMs() - sessionStartedAt,
        );
      };

      video.addEventListener("loadstart", onLoadStart);
      video.addEventListener("loadedmetadata", onLoadedMetadata);
      video.addEventListener("canplay", onCanPlay);
      video.addEventListener("play", onPlay);
      video.addEventListener("playing", onPlaying);
      video.addEventListener("waiting", onWaiting);
      video.addEventListener("stalled", onStalled);
      video.addEventListener("seeking", onSeeking);
      video.addEventListener("error", onError);
      video.addEventListener("ended", onEnded);

      if (video.networkState !== HTMLMediaElement.NETWORK_EMPTY) {
        loadStartedAt = sessionStartedAt;
      }
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) onLoadedMetadata();
      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) onCanPlay();
      if (!video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) onPlaying();

      return () => {
        emit(
          "video_playback_session_closed",
          "done",
          { waitingCount, stalledCount, seekCount, firstFrame: firstFrameSent },
          nowMs() - sessionStartedAt,
        );
        video.removeEventListener("loadstart", onLoadStart);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("canplay", onCanPlay);
        video.removeEventListener("play", onPlay);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("waiting", onWaiting);
        video.removeEventListener("stalled", onStalled);
        video.removeEventListener("seeking", onSeeking);
        video.removeEventListener("error", onError);
        video.removeEventListener("ended", onEnded);
      };
    };

    const tryBind = () => {
      if (cancelled || cleanupTelemetry) return;
      const video = videoRef.current;
      if (video) {
        cleanupTelemetry = bindToVideo(video);
        return;
      }

      bindAttempts += 1;
      if (bindAttempts >= BIND_RETRY_COUNT) {
        trackEvent("video_playback_bind_failed", {
          category: "performance",
          path: window.location.pathname,
          status: "error",
          properties: { page, videoId, sourceKind, videoUrl },
        });
        return;
      }

      retryTimer = window.setTimeout(tryBind, BIND_RETRY_MS);
    };

    tryBind();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      cleanupTelemetry?.();
    };
  }, [enabled, page, sourceKind, videoId, videoRef, videoUrl]);
}
