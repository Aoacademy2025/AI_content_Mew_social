"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { color } from "./tokens";

type Side = "left" | "right";
const STORAGE_KEY = "hero-editor-panel-widths-v1";
const MIN = { left: 220, right: 260 };
const MAX = { left: 520, right: 560 };
const PREVIEW_MIN = 240;

export function EditorPanelLayout({ children }: { children: ReactNode }) {
  const [preferred, setPreferred] = useState({ left: 266, right: 330 });
  const [containerWidth, setContainerWidth] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ side: Side; x: number; width: number } | null>(null);
  const budget = Math.max(MIN.left + MIN.right, (containerWidth || Infinity) - PREVIEW_MIN);
  const excess = preferred.left + preferred.right - MIN.left - MIN.right;
  const scale = excess > 0 ? Math.min(1, (budget - MIN.left - MIN.right) / excess) : 1;
  const widths = {
    left: Math.floor(MIN.left + (preferred.left - MIN.left) * scale),
    right: Math.floor(MIN.right + (preferred.right - MIN.right) * scale),
  };
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.right)) {
        // Browser preference is restored after hydration; the server uses default widths.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPreferred({
          left: Math.max(MIN.left, Math.min(MAX.left, saved.left)),
          right: Math.max(MIN.right, Math.min(MAX.right, saved.right)),
        });
      }
    } catch { /* Storage may be disabled or contain a malformed preference. */ }
  }, []);
  function maxWidth(side: Side) {
    return Math.min(MAX[side], budget - widths[side === "left" ? "right" : "left"]);
  }
  function updateWidth(side: Side, width: number) {
    const next = { ...widths, [side]: Math.round(Math.max(MIN[side], Math.min(maxWidth(side), width))) };
    setPreferred(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch { /* Resizing still works when browser storage is unavailable. */ }
  }
  return <div ref={container} style={{
    position: "relative", display: "flex", flex: 1, minWidth: 720, minHeight: 0,
    "--editor-left-width": `${widths.left}px`, "--editor-right-width": `${widths.right}px`,
  } as CSSProperties}>
    {children}
    {(["left", "right"] as const).map((side) => <div
      key={side}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuemin={MIN[side]}
      aria-valuemax={maxWidth(side)}
      aria-valuenow={widths[side]}
      aria-valuetext={`${widths[side]} พิกเซล`}
      aria-label={side === "left" ? "ปรับความกว้างแผงซ้าย" : "ปรับความกว้างแผงขวา"}
      title="ลากหรือใช้ปุ่มลูกศรซ้าย–ขวาเพื่อปรับความกว้าง"
      className="hover:brightness-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
      style={{
        position: "absolute", top: 0, bottom: 0, [side]: widths[side] - 4,
        width: 8, zIndex: 20, cursor: "col-resize", touchAction: "none", userSelect: "none",
        display: "flex", alignItems: "center", justifyContent: "center", color: color.textFaintest,
        outlineColor: color.primary500,
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { side, x: event.clientX, width: widths[side] };
      }}
      onPointerMove={(event) => {
        if (drag.current?.side !== side) return;
        const delta = (event.clientX - drag.current.x) * (side === "left" ? 1 : -1);
        updateWidth(side, drag.current.width + delta);
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = (event.key === "ArrowRight" ? 10 : -10) * (side === "left" ? 1 : -1);
        updateWidth(side, widths[side] + delta);
      }}
    ><span style={{ width: 3, height: 32, borderRadius: 2, background: "currentColor" }} /></div>)}
  </div>;
}
