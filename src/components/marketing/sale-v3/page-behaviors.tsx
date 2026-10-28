"use client";

import { useEffect } from "react";
import { DEMO_CLIPS } from "./demo-data";

// Small behaviours for the server-rendered sale page: the steps ruler that follows
// scroll, real clips that play when on screen, the four caption styles driven by one
// clock, tabs, copy buttons, and the waveform in the closing box. Renders nothing.

export function PageBehaviors() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".sv3");
    if (!root) return;
    const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s);
    const $$ = <T extends HTMLElement = HTMLElement>(s: string) => [...root.querySelectorAll<T>(s)];
    const ac = new AbortController();
    const on = { signal: ac.signal };
    const observers: IntersectionObserver[] = [];
    const timers: number[] = [];
    let raf = 0;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const caps = DEMO_CLIPS.brownie.caps;

    // Closing-box waveform: the brownie clip's real voice envelope.
    const fwave = $<HTMLElement>("#fwave");
    const wave = DEMO_CLIPS.brownie.wave;
    if (fwave) {
      fwave.closest("svg")?.setAttribute("viewBox", `0 0 ${wave.length} 40`);
      fwave.setAttribute("d", wave.map((p, i) => `M${i + 0.5} ${20 - Math.max(0.6, p * 19)}V${20 + Math.max(0.6, p * 19)}`).join(""));
    }

    // Steps ruler follows scroll.
    const rs = $("#rsteps");
    const rsl = $$("#rsteps li");
    const onScroll = () => {
      if (!rs || !rsl.length) return;
      rs.style.setProperty("--end", rsl[rsl.length - 1].offsetLeft + "px");
      const r = rs.getBoundingClientRect();
      const vh = innerHeight;
      const p = Math.min(1, Math.max(0, (vh * 0.85 - r.top) / (vh * 0.6)));
      rs.style.setProperty("--p", p.toFixed(3));
      rsl.forEach((li, i) => li.classList.toggle("on", p >= i / (rsl.length - 1) - 0.001));
    };
    addEventListener("scroll", () => requestAnimationFrame(onScroll), { passive: true, signal: ac.signal });
    onScroll();

    // Real clips play when on screen; a tap pauses.
    const vo = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          const v = e.target as HTMLVideoElement;
          if (e.isIntersecting) {
            if (!v.src) v.src = v.dataset.src!;
            if (!reduce) v.play().catch(() => {});
          } else v.pause();
        }),
      { threshold: 0.6 },
    );
    observers.push(vo);
    $$<HTMLVideoElement>(".out video").forEach((v) => {
      vo.observe(v);
      v.addEventListener("click", () => {
        if (!v.src) v.src = v.dataset.src!;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      }, on);
    });

    // One clip, four caption styles: one clock drives all four.
    const sv = $$<HTMLVideoElement>("#styles video");
    const sc = $$("#styles .sc");
    let sLast = -1;
    let sOn = false;
    const sTick = () => {
      if (!sOn) return;
      const t = sv[0].currentTime;
      const i = caps.findIndex((c) => t >= c[0] && t < c[1]);
      sv.slice(1).forEach((v) => {
        if (Math.abs(v.currentTime - t) > 0.15) v.currentTime = t;
      });
      if (i !== sLast) {
        sLast = i;
        sc.forEach((el) => (el.innerHTML = i < 0 ? "" : `<span class="in">${caps[i][2]}</span>`));
      }
      raf = requestAnimationFrame(sTick);
    };
    const stylesEl = $("#styles");
    if (stylesEl && sv.length) {
      const so = new IntersectionObserver(
        (es) => {
          if (es[0].isIntersecting) {
            sv.forEach((v) => {
              if (!v.src) v.src = v.dataset.src!;
            });
            if (reduce) {
              sc.forEach((el) => (el.innerHTML = `<span>${caps[4][2]}</span>`));
              return;
            }
            Promise.all(sv.map((v) => v.play().catch(() => {}))).then(() => {
              if (ac.signal.aborted) return;
              sOn = true;
              cancelAnimationFrame(raf);
              raf = requestAnimationFrame(sTick);
            });
          } else {
            sOn = false;
            sv.forEach((v) => v.pause());
          }
        },
        { threshold: 0.4 },
      );
      observers.push(so);
      so.observe(stylesEl);
    }

    // Tabs (the demo's clip picker manages itself).
    $$('[role="tablist"]:not(#picker)').forEach((list) => {
      const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
      const pick = (t: HTMLElement) => {
        tabs.forEach((x) => {
          const sel = x === t;
          x.setAttribute("aria-selected", String(sel));
          x.tabIndex = sel ? 0 : -1;
          const panel = document.getElementById(x.getAttribute("aria-controls") || "");
          if (panel) panel.hidden = !sel;
        });
        t.focus();
      };
      tabs.forEach((t, i) => {
        t.addEventListener("click", () => pick(t), on);
        t.addEventListener("keydown", (e) => {
          if (e.key === "ArrowRight") pick(tabs[(i + 1) % tabs.length]);
          if (e.key === "ArrowLeft") pick(tabs[(i - 1 + tabs.length) % tabs.length]);
        }, on);
      });
    });

    // Copy buttons.
    const copied = (b: HTMLElement, text: string) => {
      navigator.clipboard?.writeText(text).catch(() => {});
      const o = b.textContent;
      b.textContent = "คัดลอกแล้ว";
      timers.push(window.setTimeout(() => (b.textContent = o), 1600));
    };
    $$("[data-copy]").forEach((b) =>
      b.addEventListener("click", () => {
        const src = b.dataset.copy === "prev" ? b.closest("figure")?.querySelector("blockquote, pre") : document.getElementById(b.dataset.copy!);
        if (src?.textContent) copied(b, src.textContent.trim());
      }, on),
    );

    return () => {
      ac.abort();
      sOn = false;
      cancelAnimationFrame(raf);
      observers.forEach((o) => o.disconnect());
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  return null;
}
