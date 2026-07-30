"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  parseEditorStylePreset,
  type EditorStylePreset,
  type EditorStylePresetKind,
  type LogoEditorStylePreset,
  type SubtitleEditorStylePreset,
} from "@/lib/editor-style-preset-contract";
import type { LogoOverlayConfig } from "@/lib/logo-overlay";
import { trackEvent } from "@/lib/client-telemetry";
import type { V2CardLen, V2SubConfig } from "./subtitle-style";
import { PROJECT_OPERATION_BLOCKED_MESSAGE } from "./useV2Job";

type PresetApiResponse = {
  preset?: unknown;
  presets?: unknown;
  error?: string;
  message?: string;
};

function apiMessage(data: PresetApiResponse | null, fallback: string): string {
  return data?.message || data?.error || fallback;
}

export function useEditorStylePresets(input: {
  subtitleConfig: V2SubConfig;
  subtitleCardLen: V2CardLen;
  logoConfig?: LogoOverlayConfig;
  onApplySubtitle: (config: V2SubConfig, cardLen: V2CardLen) => void;
  onApplyLogo: (config: LogoOverlayConfig) => void;
  /** M2: apply(logo) ต้องรู้ว่า onApplyLogo จะโดนเงียบ (canAcceptUserMutation ของ
   *  useV2Project = false เช่นระหว่าง recovery conflict) ก่อนจะ toast สำเร็จ — ค่าเดียวกับ
   *  p.canRunProjectOperation ที่ useV2Job ใช้เช็คก่อนยิง action อื่นทั้งหมด ไม่ระบุ = ถือว่าพร้อมเสมอ */
  canApplyLogo?: () => boolean;
}) {
  const [presets, setPresets] = useState<EditorStylePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/user/editor-style-presets", {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await response.json().catch(() => null) as PresetApiResponse | null;
        if (!response.ok) throw new Error(apiMessage(data, "โหลดพรีเซ็ตไม่สำเร็จ"));
        const values = Array.isArray(data?.presets) ? data.presets : [];
        setPresets(values.map(parseEditorStylePreset).filter((preset): preset is EditorStylePreset => Boolean(preset)));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        toast.error(error instanceof Error ? error.message : "โหลดพรีเซ็ตไม่สำเร็จ");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const subtitle = useMemo(
    () => presets.filter((preset): preset is SubtitleEditorStylePreset => preset.kind === "subtitle"),
    [presets],
  );
  const logo = useMemo(
    () => presets.filter((preset): preset is LogoEditorStylePreset => preset.kind === "logo"),
    [presets],
  );

  async function save(kind: EditorStylePresetKind, name: string): Promise<boolean> {
    const config = kind === "subtitle"
      ? { ...input.subtitleConfig, cardLen: input.subtitleCardLen }
      : input.logoConfig;
    if (!config || busy) return false;
    setBusy(true);
    try {
      const response = await fetch("/api/user/editor-style-presets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, name, config }),
      });
      const data = await response.json().catch(() => null) as PresetApiResponse | null;
      if (!response.ok) throw new Error(apiMessage(data, "บันทึกพรีเซ็ตไม่สำเร็จ"));
      const preset = parseEditorStylePreset(data?.preset);
      if (!preset) throw new Error("ข้อมูลพรีเซ็ตที่บันทึกไม่สมบูรณ์");
      setPresets((current) => [
        preset,
        ...current.filter((item) => item.id !== preset.id),
      ]);
      toast.success(`บันทึกพรีเซ็ต “${preset.name}” แล้ว`);
      trackEvent("editor_style_preset_saved", {
        status: "done",
        properties: { kind },
      });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "บันทึกพรีเซ็ตไม่สำเร็จ");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function apply(preset: EditorStylePreset) {
    if (preset.kind === "subtitle") {
      const { cardLen, ...config } = preset.config;
      input.onApplySubtitle(config, cardLen);
    } else {
      // M2: onApplyLogo (p.setLogoOverlay) no-ops silently while the project can't
      // accept a mutation (e.g. recovery conflict) — check first so we never toast a
      // success the editor state didn't actually receive.
      if (input.canApplyLogo && !input.canApplyLogo()) {
        toast.error(PROJECT_OPERATION_BLOCKED_MESSAGE);
        return;
      }
      // M9: the preset still carries `enabled` for backward compatibility with rows
      // saved before this fix, but apply must never use it to flip the user's current
      // layer toggle — keep whatever is live now (no config yet = on, so the preset is
      // visibly applied instead of landing hidden).
      input.onApplyLogo({ ...preset.config, enabled: input.logoConfig?.enabled ?? true });
    }
    toast.success(`ใช้พรีเซ็ต “${preset.name}” แล้ว`);
    trackEvent("editor_style_preset_applied", {
      status: "done",
      properties: { kind: preset.kind },
    });
  }

  async function restore(preset: EditorStylePreset) {
    try {
      const response = await fetch("/api/user/editor-style-presets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: preset.kind,
          name: preset.name,
          config: preset.config,
        }),
      });
      const data = await response.json().catch(() => null) as PresetApiResponse | null;
      if (!response.ok) throw new Error(apiMessage(data, "กู้คืนพรีเซ็ตไม่สำเร็จ"));
      const restored = parseEditorStylePreset(data?.preset);
      if (!restored) throw new Error("ข้อมูลพรีเซ็ตที่กู้คืนไม่สมบูรณ์");
      setPresets((current) => [
        restored,
        ...current.filter((item) => item.id !== restored.id),
      ]);
      toast.success(`กู้คืนพรีเซ็ต “${restored.name}” แล้ว`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "กู้คืนพรีเซ็ตไม่สำเร็จ");
    }
  }

  async function remove(preset: EditorStylePreset): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/user/editor-style-presets/${encodeURIComponent(preset.id)}`,
        { method: "DELETE" },
      );
      const data = await response.json().catch(() => null) as PresetApiResponse | null;
      if (!response.ok) throw new Error(apiMessage(data, "ลบพรีเซ็ตไม่สำเร็จ"));
      setPresets((current) => current.filter((item) => item.id !== preset.id));
      toast(`ลบพรีเซ็ต “${preset.name}” แล้ว`, {
        duration: 8000,
        action: {
          label: "เลิกทำ",
          onClick: () => void restore(preset),
        },
      });
      trackEvent("editor_style_preset_deleted", {
        status: "done",
        properties: { kind: preset.kind },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ลบพรีเซ็ตไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return {
    subtitle,
    logo,
    loading,
    busy,
    save,
    apply,
    remove,
  };
}
