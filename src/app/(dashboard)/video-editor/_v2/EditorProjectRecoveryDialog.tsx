"use client";

import { useEffect, useRef } from "react";
import { Cloud, HardDrive, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createBlockingDialogHistory } from "@/lib/editor-project-conflict-history";
import {
  createEditorRecoveryFocusLifecycle,
  type EditorRecoveryFocusTarget,
} from "@/lib/editor-project-conflict-focus";
import { color, font } from "./tokens";
import type { EditorProjectRecoveryState } from "./useV2Project";

function formatCandidateTimestamp(value: string | null): string {
  if (!value) return "ไม่ทราบเวลา";
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return "ไม่ทราบเวลา";
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function EditorProjectRecoveryDialog(props: {
  recovery: EditorProjectRecoveryState;
  onRetryLoad: () => void;
  onChooseLocal: () => Promise<void>;
  onChooseServer: () => void;
}): React.ReactNode {
  const { recovery, onRetryLoad, onChooseLocal, onChooseServer } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusLifecycleRef = useRef<ReturnType<typeof createEditorRecoveryFocusLifecycle> | null>(null);
  const blocking = recovery.status !== "none";
  const isConflict = recovery.status === "conflict";
  const isResolving = isConflict && recovery.resolving !== false;

  useEffect(() => {
    if (!blocking || typeof window === "undefined") return;
    return createBlockingDialogHistory({
      history: window.history,
      addPopStateListener(listener) {
        window.addEventListener("popstate", listener);
        return () => window.removeEventListener("popstate", listener);
      },
    }).activate();
  }, [blocking]);

  useEffect(() => {
    const lifecycle = focusLifecycle();
    lifecycle.setup();
    return () => lifecycle.dispose();
  }, []);

  const focusLifecycle = () => {
    if (!focusLifecycleRef.current) {
      focusLifecycleRef.current = createEditorRecoveryFocusLifecycle({
        getActiveElement: () => document.activeElement instanceof HTMLElement
          && document.activeElement !== document.body
          && document.activeElement !== document.documentElement
          ? document.activeElement as EditorRecoveryFocusTarget
          : null,
        getHeading: () => headingRef.current,
        getFallback: () => document.querySelector<HTMLElement>('[data-editor-recovery-focus-fallback="true"]'),
      });
    }
    return focusLifecycleRef.current;
  };

  const title = recovery.status === "loading"
    ? "กำลังโหลดโปรเจกต์"
    : recovery.status === "load-error"
      ? "โหลดโปรเจกต์ไม่สำเร็จ"
      : "พบข้อมูลโปรเจกต์ 2 เวอร์ชัน";
  const description = recovery.status === "loading"
    ? "กำลังตรวจสอบข้อมูลล่าสุดบนระบบก่อนเปิดให้แก้ไข"
    : recovery.status === "load-error"
      ? "ยังไม่สามารถเปิดข้อมูลโปรเจกต์ได้ โปรดลองเชื่อมต่อใหม่อีกครั้ง"
      : "โปรเจกต์นี้มีการแก้ไขในเครื่องที่ยังไม่ตรงกับข้อมูลบนระบบ กรุณาเลือกเวอร์ชันที่ต้องการใช้";

  return (
    <AlertDialog open={blocking}>
      <AlertDialogContent
        onEscapeKeyDown={(event) => event.preventDefault()}
        overlayClassName="motion-reduce:!animate-none motion-reduce:!transition-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusLifecycle().open();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusLifecycle().close();
        }}
        aria-busy={isResolving || undefined}
        className="max-h-[calc(100dvh-32px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100vw-32px-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-[560px] gap-0 overflow-x-hidden overflow-y-auto rounded-[16px] border p-0 motion-reduce:!animate-none motion-reduce:!transition-none sm:rounded-[16px]"
        style={{
          background: color.bg1,
          borderColor: color.cardBorder,
          color: color.text,
          left: "calc(env(safe-area-inset-left) + (100vw - env(safe-area-inset-left) - env(safe-area-inset-right)) / 2)",
          top: "calc(env(safe-area-inset-top) + (100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom)) / 2)",
          paddingBottom: "calc(20px + env(safe-area-inset-bottom))",
        }}
      >
        <div className="px-5 pt-5 sm:px-7 sm:pt-7">
          <div
            className="mb-4 h-1 w-10 rounded-full"
            style={{ background: recovery.status === "conflict" ? color.warning : color.primary500 }}
            aria-hidden="true"
          />
          <AlertDialogHeader className="space-y-2.5 text-left">
            <AlertDialogTitle
              ref={headingRef}
              tabIndex={-1}
              className="text-[1.25rem] leading-[1.45] tracking-[-0.01em] outline-none sm:text-[1.375rem]"
              style={{ fontFamily: font.heading, fontWeight: 600, color: color.text }}
            >
              {title}
            </AlertDialogTitle>
            <AlertDialogDescription
              className="text-[0.95rem] leading-7"
              style={{ fontFamily: font.body, color: color.textSecondary }}
            >
              {description}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {recovery.status === "loading" ? (
            <div
              role="status"
              className="mt-7 flex min-h-11 items-center gap-3"
              style={{ color: color.textSecondary, fontFamily: font.body }}
            >
              <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span className="text-sm">กำลังตรวจสอบฉบับล่าสุด…</span>
            </div>
          ) : recovery.status === "load-error" ? (
            <>
              <div
                role="alert"
                className="mt-6 rounded-[10px] border px-4 py-3 text-sm leading-6"
                style={{
                  borderColor: "rgba(248,113,113,.35)",
                  background: "rgba(248,113,113,.07)",
                  color: color.danger,
                  fontFamily: font.body,
                }}
              >
                {recovery.message}
              </div>
              <AlertDialogFooter className="mt-6 flex-col sm:justify-start sm:space-x-0">
                <AlertDialogAction
                  onClick={(event) => {
                    event.preventDefault();
                    onRetryLoad();
                  }}
                  className="min-h-11 w-full border bg-white/[.055] px-5 text-sm hover:bg-white/[.09] focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none sm:w-auto"
                  style={{
                    borderColor: color.cardBorder,
                    color: color.text,
                    fontFamily: font.heading,
                    boxShadow: "none",
                  }}
                >
                  ลองใหม่
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : recovery.status === "conflict" ? (
            <>
              <div className="mt-6 overflow-hidden rounded-[12px] border" style={{ borderColor: color.cardBorder }}>
                <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                  <HardDrive size={17} style={{ color: color.warning }} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium" style={{ fontFamily: font.heading, color: color.text }}>
                      ฉบับในเครื่อง
                    </div>
                    <div className="mt-0.5 text-xs tabular-nums" style={{ fontFamily: font.body, color: color.textFaint }}>
                      แก้ไขล่าสุด {formatCandidateTimestamp(recovery.local.updatedAt)}
                    </div>
                  </div>
                </div>
                <div className="h-px" style={{ background: color.cardBorder }} />
                <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                  <Cloud size={17} style={{ color: color.primary300 }} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium" style={{ fontFamily: font.heading, color: color.text }}>
                      ฉบับบนระบบ
                    </div>
                    <div className="mt-0.5 text-xs tabular-nums" style={{ fontFamily: font.body, color: color.textFaint }}>
                      แก้ไขล่าสุด {formatCandidateTimestamp(recovery.server.updatedAt)}
                    </div>
                  </div>
                </div>
              </div>

              {recovery.error ? (
                <div
                  role="alert"
                  className="mt-4 rounded-[10px] border px-4 py-3 text-sm leading-6"
                  style={{
                    borderColor: "rgba(248,113,113,.35)",
                    background: "rgba(248,113,113,.07)",
                    color: color.danger,
                    fontFamily: font.body,
                  }}
                >
                  {recovery.error}
                </div>
              ) : null}

              <AlertDialogFooter className="mt-6 flex flex-col gap-4 sm:grid sm:grid-cols-2 sm:space-x-0">
                <div className="flex flex-col gap-2">
                  <AlertDialogAction
                    disabled={isResolving}
                    onClick={(event) => {
                      event.preventDefault();
                      void onChooseLocal();
                    }}
                    className="min-h-11 w-full border bg-white/[.055] px-4 text-sm hover:bg-white/[.09] focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-45"
                    style={{
                      borderColor: color.cardBorder,
                      color: color.text,
                      fontFamily: font.heading,
                      boxShadow: "none",
                    }}
                  >
                    {recovery.resolving === "local" ? (
                      <Loader2 size={16} className="mr-2 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : null}
                    ใช้ฉบับในเครื่อง
                  </AlertDialogAction>
                  <p className="px-1 text-xs leading-5" style={{ color: color.textFaint, fontFamily: font.body }}>
                    ฉบับนี้จะแทนที่ฉบับบนระบบ
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <AlertDialogAction
                    disabled={isResolving}
                    onClick={(event) => {
                      event.preventDefault();
                      onChooseServer();
                    }}
                    className="min-h-11 w-full border bg-white/[.055] px-4 text-sm hover:bg-white/[.09] focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-45"
                    style={{
                      borderColor: color.cardBorder,
                      color: color.text,
                      fontFamily: font.heading,
                      boxShadow: "none",
                    }}
                  >
                    {recovery.resolving === "server" ? (
                      <Loader2 size={16} className="mr-2 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    ) : null}
                    ใช้ฉบับบนระบบ
                  </AlertDialogAction>
                  <p className="px-1 text-xs leading-5" style={{ color: color.textFaint, fontFamily: font.body }}>
                    ฉบับนี้จะแทนที่ฉบับในเครื่อง
                  </p>
                </div>
              </AlertDialogFooter>
            </>
          ) : null}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
