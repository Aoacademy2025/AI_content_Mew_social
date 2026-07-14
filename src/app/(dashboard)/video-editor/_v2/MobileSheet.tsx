"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  clampSheetDragTranslation,
  shouldDismissSheetDrag,
  type MobileSheetSize,
} from "@/lib/mobile-sheet";
import { color, font, radius } from "./tokens";

export type { MobileSheetSize } from "@/lib/mobile-sheet";

const SHEET_HISTORY_KEY = "__heroAiMobileSheet";
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let historyToken: string | null = null;
let historyPopPending = false;
const openSheetIds = new Set<string>();
let bodyLockCount = 0;
let savedBodyStyles: { overflow: string; overscrollBehavior: string; paddingRight: string } | null = null;

function getHistoryToken() {
  if (!historyToken) {
    historyToken = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `mobile-sheet-${crypto.randomUUID()}`
      : `mobile-sheet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return historyToken;
}

function currentHistoryEntryIsSheet() {
  if (typeof window === "undefined") return false;
  const state = window.history.state;
  return !!state
    && typeof state === "object"
    && state[SHEET_HISTORY_KEY] === getHistoryToken();
}

function ensureSheetHistoryEntry() {
  if (typeof window === "undefined" || currentHistoryEntryIsSheet()) return;
  const state = window.history.state;
  const preservedState = state && typeof state === "object" ? state : {};
  window.history.pushState(
    { ...preservedState, [SHEET_HISTORY_KEY]: getHistoryToken() },
    "",
    window.location.href,
  );
}

function consumeSheetHistoryEntry() {
  if (typeof window === "undefined" || !currentHistoryEntryIsSheet() || historyPopPending) {
    return false;
  }
  historyPopPending = true;
  window.addEventListener("popstate", () => { historyPopPending = false; }, { once: true });
  window.history.back();
  return true;
}

function registerOpenSheet(id: string) {
  openSheetIds.add(id);
  ensureSheetHistoryEntry();
}

function unregisterOpenSheet(id: string) {
  openSheetIds.delete(id);
  queueMicrotask(() => {
    if (openSheetIds.size === 0) consumeSheetHistoryEntry();
  });
}

function lockBodyScroll() {
  if (typeof document === "undefined") return;
  if (bodyLockCount === 0) {
    savedBodyStyles = {
      overflow: document.body.style.overflow,
      overscrollBehavior: document.body.style.overscrollBehavior,
      paddingRight: document.body.style.paddingRight,
    };
    const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
  }
  bodyLockCount += 1;
}

function unlockBodyScroll() {
  if (typeof document === "undefined" || bodyLockCount === 0) return;
  bodyLockCount -= 1;
  if (bodyLockCount > 0 || !savedBodyStyles) return;
  document.body.style.overflow = savedBodyStyles.overflow;
  document.body.style.overscrollBehavior = savedBodyStyles.overscrollBehavior;
  document.body.style.paddingRight = savedBodyStyles.paddingRight;
  savedBodyStyles = null;
}

function focusableDescendants(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => (
    element.getAttribute("aria-hidden") !== "true"
    && element.getAttribute("tabindex") !== "-1"
    && (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0)
  ));
}

type DragState = {
  pointerId: number;
  startY: number;
  lastY: number;
  lastAt: number;
  velocityY: number;
};

export function MobileSheet({
  open,
  onClose,
  title,
  size = "large",
  triggerRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: MobileSheetSize;
  triggerRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}): ReactNode {
  const id = useId();
  const titleId = `${id}-title`;
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const dragRef = useRef<DragState | null>(null);
  const [dragTranslation, setDragTranslation] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  onCloseRef.current = onClose;

  const requestClose = useCallback(() => {
    if (!consumeSheetHistoryEntry()) onCloseRef.current();
  }, []);

  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    if (!sheet) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    registerOpenSheet(id);
    lockBodyScroll();

    const focusFirstControl = () => {
      const first = focusableDescendants(sheet)[0];
      (first ?? sheet).focus({ preventScroll: true });
    };
    const focusFrame = window.requestAnimationFrame(() => {
      setSheetVisible(true);
      focusFirstControl();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableDescendants(sheet);
      if (focusable.length === 0) {
        event.preventDefault();
        sheet.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!sheet.contains(event.target as Node)) focusFirstControl();
    };
    const onPopState = () => onCloseRef.current();

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("popstate", onPopState);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("popstate", onPopState);
      unregisterOpenSheet(id);
      unlockBodyScroll();
      setDragTranslation(0);
      setDragging(false);
      setSheetVisible(false);
      const focusTarget = triggerRef?.current ?? previousFocusRef.current;
      window.requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
    };
  }, [id, open, requestClose, triggerRef]);

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      lastAt: event.timeStamp,
      velocityY: 0,
    };
    setDragging(true);
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const elapsed = event.timeStamp - drag.lastAt;
    if (elapsed > 0) drag.velocityY = (event.clientY - drag.lastY) / elapsed;
    drag.lastY = event.clientY;
    drag.lastAt = event.timeStamp;
    setDragTranslation(clampSheetDragTranslation(event.clientY - drag.startY));
  }

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>, canceled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    const distanceY = event.clientY - drag.startY;
    const releaseElapsed = event.timeStamp - drag.lastAt;
    const releaseVelocity = releaseElapsed > 0
      ? (event.clientY - drag.lastY) / releaseElapsed
      : drag.velocityY;
    if (!canceled && shouldDismissSheetDrag({ distanceY, velocityY: releaseVelocity })) {
      requestClose();
      return;
    }
    setDragTranslation(0);
  }

  if (!open) return null;

  const medium = size === "medium";
  return (
    <>
      <div
        data-mobile-sheet-scrim="true"
        aria-hidden="true"
        onPointerDown={(event) => {
          event.preventDefault();
          requestClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 80,
          background: "rgba(0,0,0,.62)",
          pointerEvents: "auto",
          touchAction: "none",
          animation: "mobile-sheet-scrim-in 180ms ease-out both",
        }}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-mobile-sheet-size={size}
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 81,
          height: medium ? "min(60dvh, 620px)" : undefined,
          maxHeight: medium ? "min(60dvh, 620px)" : "94dvh",
          display: "flex",
          flexDirection: "column",
          transform: dragging || dragTranslation > 0
            ? `translate3d(0, ${dragTranslation}px, 0)`
            : sheetVisible ? "translate3d(0, 0, 0)" : "translate3d(0, 100%, 0)",
          transition: dragging ? "none" : "transform 240ms cubic-bezier(.22,1,.36,1)",
          pointerEvents: "auto",
          background: "rgba(20,20,32,.96)",
          backdropFilter: "blur(28px) saturate(150%)",
          WebkitBackdropFilter: "blur(28px) saturate(150%)",
          borderTop: "1px solid rgba(255,255,255,.12)",
          borderRadius: `${radius.panel}px ${radius.panel}px 0 0`,
          boxShadow: "0 -20px 60px rgba(0,0,0,.5)",
          willChange: "transform",
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          aria-label="ลากลงเพื่อปิดแผง"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          className="flex shrink-0 items-center justify-center"
          style={{
            width: 72,
            height: 44,
            margin: "0 auto -4px",
            padding: 0,
            border: 0,
            background: "transparent",
            color: color.textSecondary,
            cursor: "grab",
            touchAction: "none",
          }}
        >
          <span
            aria-hidden="true"
            style={{ width: 40, height: 4, borderRadius: radius.pill, background: "rgba(255,255,255,.24)" }}
          />
        </button>
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2">
          <h2 id={titleId} style={{ margin: 0, font: `600 15px ${font.heading}`, color: color.text }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={requestClose}
            style={{
              minWidth: 60,
              minHeight: 44,
              padding: "8px 14px",
              borderRadius: radius.control,
              border: `1px solid ${color.cardBorder}`,
              background: "rgba(255,255,255,.04)",
              color: color.textSecondary,
              font: `500 13px ${font.body}`,
              cursor: "pointer",
            }}
          >
            เสร็จ
          </button>
        </div>
        <div
          data-mobile-sheet-scroll="true"
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4"
          style={{
            paddingBottom: "calc(20px + env(safe-area-inset-bottom))",
            overscrollBehavior: "contain",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {children}
        </div>
        <style>{`
          @keyframes mobile-sheet-scrim-in { from { opacity: 0; } to { opacity: 1; } }
          @media (prefers-reduced-motion: reduce) {
            [data-mobile-sheet-scrim="true"], [data-mobile-sheet-size] { animation: none !important; transition: none !important; }
          }
        `}</style>
      </div>
    </>
  );
}
