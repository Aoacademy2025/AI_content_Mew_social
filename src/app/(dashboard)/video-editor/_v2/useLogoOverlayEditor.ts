"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "@/lib/client-telemetry";
import {
  DEFAULT_LOGO_OPACITY,
  DEFAULT_LOGO_POSITION,
  DEFAULT_LOGO_SIZE_PCT,
  LOGO_POSITIONS,
  normalizeLogoOverlayConfig,
  type BrandAssetView,
  type LogoOverlayConfig,
  type LogoPosition,
} from "@/lib/logo-overlay";

export const LOGO_PICKER_ACCEPT =
  "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";
export const LOGO_PICKER_FORMAT_LABEL = "PNG, JPG หรือ WebP · สูงสุด 5 MB";

export type LogoEditorSurface = "desktop" | "mobile";
export type LogoProjectSaveStatus = "idle" | "saving" | "saved" | "error";
export type LogoUploadSizeBucket = "under-1mb" | "1-5mb" | "over-5mb";

type LogoTelemetryInput = Record<string, unknown>;
type LogoTelemetryProperties = Partial<{
  planEligible: boolean;
  errorCode: string;
  sizeBucket: LogoUploadSizeBucket;
  position: LogoPosition;
  enabled: boolean;
  surface: LogoEditorSurface;
}>;

type ParsedLogoUploadResponse =
  | { ok: true; asset: BrandAssetView }
  | { ok: false; errorCode: string; message: string };

const KNOWN_ERROR_CODES = new Set([
  "plan_required",
  "project_not_found",
  "unsupported_type",
  "payload_too_large",
  "empty_file",
  "corrupt_image",
  "dimensions_too_large",
  "asset_not_found",
  "asset_in_use",
  "invalid_config",
  "invalid_body",
  "invalid_response",
  "rate_limited",
  "network",
  "unknown",
]);

const KNOWN_SIZE_BUCKETS = new Set<LogoUploadSizeBucket>([
  "under-1mb",
  "1-5mb",
  "over-5mb",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLogoPosition(value: unknown): value is LogoPosition {
  return typeof value === "string"
    && LOGO_POSITIONS.some((position) => position === value);
}

function parseBrandAssetView(value: unknown): BrandAssetView | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string"
    || !value.id.trim()
    || typeof value.displayName !== "string"
    || value.mimeType !== "image/webp"
    || typeof value.sizeBytes !== "number"
    || !Number.isFinite(value.sizeBytes)
    || value.sizeBytes < 0
    || typeof value.width !== "number"
    || !Number.isFinite(value.width)
    || value.width <= 0
    || typeof value.height !== "number"
    || !Number.isFinite(value.height)
    || value.height <= 0
    || typeof value.imageUrl !== "string"
    || !value.imageUrl
  ) {
    return null;
  }
  return {
    id: value.id,
    displayName: value.displayName,
    mimeType: "image/webp",
    sizeBytes: value.sizeBytes,
    width: value.width,
    height: value.height,
    imageUrl: value.imageUrl,
  };
}

export function buildLogoUploadFormData(file: File, projectId: string): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("projectId", projectId);
  return form;
}

export function logoUploadSizeBucket(sizeBytes: number): LogoUploadSizeBucket {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 1024 * 1024) return "under-1mb";
  if (sizeBytes <= 5 * 1024 * 1024) return "1-5mb";
  return "over-5mb";
}

export function normalizeLogoTelemetryErrorCode(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return KNOWN_ERROR_CODES.has(normalized) ? normalized : "unknown";
}

/** Allowlist-only builder: arbitrary caller keys never cross the telemetry boundary. */
export function buildLogoTelemetryProperties(
  input: LogoTelemetryInput,
): LogoTelemetryProperties {
  const output: LogoTelemetryProperties = {};
  if (typeof input.planEligible === "boolean") {
    output.planEligible = input.planEligible;
  }
  if (input.errorCode !== undefined) {
    output.errorCode = normalizeLogoTelemetryErrorCode(input.errorCode);
  }
  if (
    typeof input.sizeBucket === "string"
    && KNOWN_SIZE_BUCKETS.has(input.sizeBucket as LogoUploadSizeBucket)
  ) {
    output.sizeBucket = input.sizeBucket as LogoUploadSizeBucket;
  }
  if (isLogoPosition(input.position)) output.position = input.position;
  if (typeof input.enabled === "boolean") output.enabled = input.enabled;
  if (input.surface === "desktop" || input.surface === "mobile") {
    output.surface = input.surface;
  }
  return output;
}

export function parseLogoUploadResponse(
  status: number,
  payload: unknown,
): ParsedLogoUploadResponse {
  if (status === 201 && isRecord(payload)) {
    const asset = parseBrandAssetView(payload.asset);
    if (asset) return { ok: true, asset };
  }

  if (status !== 201 && isRecord(payload)) {
    return {
      ok: false,
      errorCode: normalizeLogoTelemetryErrorCode(payload.error),
      message:
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message
          : "อัปโหลดโลโก้ไม่สำเร็จ",
    };
  }

  return {
    ok: false,
    errorCode: "invalid_response",
    message: "อัปโหลดโลโก้ไม่สำเร็จ",
  };
}

function trackLogoEvent(
  name:
    | "logo_overlay_upload_started"
    | "logo_overlay_upload_done"
    | "logo_overlay_upload_error"
    | "logo_overlay_toggled"
    | "logo_overlay_default_saved",
  input: LogoTelemetryInput,
) {
  trackEvent(name, {
    properties: buildLogoTelemetryProperties(input),
  });
}

export function useLogoOverlayEditor(input: {
  projectId: string | null;
  eligible: boolean;
  value: LogoOverlayConfig | undefined;
  onChange: (next: LogoOverlayConfig | undefined) => void;
  projectSaveStatus: LogoProjectSaveStatus;
  onRetryProjectSave: () => void;
  surface?: LogoEditorSurface;
}) {
  const {
    projectId,
    eligible,
    value,
    onChange,
    projectSaveStatus,
    onRetryProjectSave,
    surface = "desktop",
  } = input;
  const normalizedValue = useMemo(
    () => normalizeLogoOverlayConfig(value) ?? undefined,
    [value],
  );
  const [asset, setAsset] = useState<BrandAssetView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const projectOnlyAssetIds = useRef(new Set<string>());
  const cleanupTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const assetId = normalizedValue?.assetId;
    if (!assetId) {
      setAsset(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setAsset((current) => current?.id === assetId ? current : null);
    void fetch(`/api/user/brand-assets/${encodeURIComponent(assetId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || !isRecord(payload)) {
          throw new Error(
            isRecord(payload) && typeof payload.message === "string"
              ? payload.message
              : "โหลดโลโก้ไม่สำเร็จ",
          );
        }
        const nextAsset = parseBrandAssetView(payload.asset);
        if (!nextAsset || nextAsset.id !== assetId) {
          throw new Error("โหลดโลโก้ไม่สำเร็จ");
        }
        setAsset(nextAsset);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAsset(null);
        setMutationError(
          error instanceof Error ? error.message : "โหลดโลโก้ไม่สำเร็จ",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [normalizedValue?.assetId]);

  useEffect(() => () => {
    for (const timer of cleanupTimers.current) clearTimeout(timer);
    cleanupTimers.current.clear();
  }, []);

  const deleteAfterAutosave = useCallback((assetId: string) => {
    if (!projectOnlyAssetIds.current.has(assetId)) return;
    projectOnlyAssetIds.current.delete(assetId);
    const timer = setTimeout(() => {
      cleanupTimers.current.delete(timer);
      void fetch(`/api/user/brand-assets/${encodeURIComponent(assetId)}`, {
        method: "DELETE",
      }).catch(() => {});
    }, 1_100);
    cleanupTimers.current.add(timer);
  }, []);

  const updateConfig = useCallback((patch: Partial<LogoOverlayConfig>) => {
    if (!eligible || !normalizedValue) return;
    const next = normalizeLogoOverlayConfig({ ...normalizedValue, ...patch });
    if (next) onChange(next);
  }, [eligible, normalizedValue, onChange]);

  const setEnabled = useCallback((enabled: boolean) => {
    if (!eligible || !normalizedValue) return;
    updateConfig({ enabled });
    trackLogoEvent("logo_overlay_toggled", {
      planEligible: eligible,
      enabled,
      position: normalizedValue.position,
      surface,
    });
  }, [eligible, normalizedValue, surface, updateConfig]);

  const setPosition = useCallback((position: LogoPosition) => {
    updateConfig({ position });
  }, [updateConfig]);

  const setSizePct = useCallback((sizePct: number) => {
    updateConfig({ sizePct });
  }, [updateConfig]);

  const setOpacity = useCallback((opacity: number) => {
    updateConfig({ opacity });
  }, [updateConfig]);

  const upload = useCallback(async (file: File): Promise<boolean> => {
    const sizeBucket = logoUploadSizeBucket(file.size);
    trackLogoEvent("logo_overlay_upload_started", {
      planEligible: eligible,
      sizeBucket,
      surface,
    });

    if (!eligible) {
      setMutationError("Logo Overlay ใช้ได้เฉพาะแผน Pro หรือ Business");
      trackLogoEvent("logo_overlay_upload_error", {
        planEligible: false,
        errorCode: "plan_required",
        sizeBucket,
        surface,
      });
      return false;
    }
    if (!projectId) {
      setMutationError("ไม่พบโปรเจกต์ กรุณาลองบันทึกโปรเจกต์อีกครั้ง");
      trackLogoEvent("logo_overlay_upload_error", {
        planEligible: true,
        errorCode: "project_not_found",
        sizeBucket,
        surface,
      });
      return false;
    }

    setSaving(true);
    setMutationError(null);
    try {
      const response = await fetch("/api/user/brand-assets", {
        method: "POST",
        body: buildLogoUploadFormData(file, projectId),
      });
      const payload: unknown = await response.json().catch(() => null);
      const parsed = parseLogoUploadResponse(response.status, payload);
      if (!parsed.ok) {
        setMutationError(parsed.message);
        trackLogoEvent("logo_overlay_upload_error", {
          planEligible: true,
          errorCode: parsed.errorCode,
          sizeBucket,
          surface,
        });
        return false;
      }

      const previous = normalizedValue;
      const next = normalizeLogoOverlayConfig(previous
        ? { ...previous, assetId: parsed.asset.id }
        : {
            enabled: true,
            assetId: parsed.asset.id,
            position: DEFAULT_LOGO_POSITION,
            sizePct: DEFAULT_LOGO_SIZE_PCT,
            opacity: DEFAULT_LOGO_OPACITY,
          });
      if (!next) {
        setMutationError("อัปโหลดโลโก้ไม่สำเร็จ");
        return false;
      }

      projectOnlyAssetIds.current.add(parsed.asset.id);
      setAsset(parsed.asset);
      onChange(next);
      if (previous && previous.assetId !== parsed.asset.id) {
        deleteAfterAutosave(previous.assetId);
      }
      trackLogoEvent("logo_overlay_upload_done", {
        planEligible: true,
        sizeBucket,
        position: next.position,
        surface,
      });
      return true;
    } catch {
      setMutationError("เชื่อมต่อไม่สำเร็จ กรุณาลองอัปโหลดอีกครั้ง");
      trackLogoEvent("logo_overlay_upload_error", {
        planEligible: true,
        errorCode: "network",
        sizeBucket,
        surface,
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, [deleteAfterAutosave, eligible, normalizedValue, onChange, projectId, surface]);

  const saveAsDefault = useCallback(async (): Promise<boolean> => {
    if (!eligible || !normalizedValue) return false;
    setSaving(true);
    setMutationError(null);
    try {
      const response = await fetch(
        `/api/user/brand-assets/${encodeURIComponent(normalizedValue.assetId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setAsDefault: true,
            enabled: normalizedValue.enabled,
            position: normalizedValue.position,
            sizePct: normalizedValue.sizePct,
            opacity: normalizedValue.opacity,
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        setMutationError("ตั้งเป็นโลโก้หลักไม่สำเร็จ");
        return false;
      }
      projectOnlyAssetIds.current.delete(normalizedValue.assetId);
      trackLogoEvent("logo_overlay_default_saved", {
        planEligible: true,
        position: normalizedValue.position,
        surface,
      });
      return true;
    } catch {
      setMutationError("ตั้งเป็นโลโก้หลักไม่สำเร็จ");
      return false;
    } finally {
      setSaving(false);
    }
  }, [eligible, normalizedValue, surface]);

  const removeFromProject = useCallback(() => {
    if (!eligible || !normalizedValue) return;
    onChange(undefined);
    setAsset(null);
    setMutationError(null);
    deleteAfterAutosave(normalizedValue.assetId);
  }, [deleteAfterAutosave, eligible, normalizedValue, onChange]);

  const error = projectSaveStatus === "error"
    ? "ยังไม่ได้บันทึก"
    : mutationError;
  const unsaved = saving
    || projectSaveStatus === "saving"
    || projectSaveStatus === "error";

  return {
    asset,
    loading,
    saving,
    unsaved,
    error,
    setEnabled,
    setPosition,
    setSizePct,
    setOpacity,
    upload,
    saveAsDefault,
    removeFromProject,
    retryProjectSave: onRetryProjectSave,
  };
}

export type LogoOverlayEditor = ReturnType<typeof useLogoOverlayEditor>;
