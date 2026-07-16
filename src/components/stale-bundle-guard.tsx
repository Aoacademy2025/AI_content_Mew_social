"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { isStaleBundleResourceError, isStaleBundleSignal } from "@/lib/stale-bundle";

const TOAST_ID = "stale-bundle";

// Global, tab-scoped detector for the "stale client bundle" class of errors described in
// src/lib/stale-bundle.ts: a tab left open across a deploy still holds a pre-deploy Server
// Action ID / JS-CSS chunk hash that no longer exists on the rebuilt server. Shows a
// one-time Thai toast with a manual reload button (no auto-reload — avoids any risk of a
// reload loop if a false positive ever slips through) the first time either signature is
// seen, then stays quiet for the rest of the tab's life (further clicks/interactions would
// otherwise keep failing until the user refreshes anyway, so repeat toasts add nothing).
export function StaleBundleGuard() {
  const shownRef = useRef(false);

  useEffect(() => {
    const showToast = () => {
      if (shownRef.current) return;
      shownRef.current = true;
      toast("มีเวอร์ชันใหม่ของเว็บพร้อมใช้งาน — กรุณารีเฟรชหน้า", {
        id: TOAST_ID,
        duration: Infinity,
        action: {
          label: "รีเฟรช",
          onClick: () => window.location.reload(),
        },
      });
    };

    const onError = (event: ErrorEvent) => {
      const name = event.error instanceof Error ? event.error.name : undefined;
      if (isStaleBundleSignal({ message: event.message, name })) {
        showToast();
      }
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? "");
      const name = reason instanceof Error ? reason.name : undefined;
      if (isStaleBundleSignal({ message, name })) {
        showToast();
      }
    };

    // Resource load failures (an old CSS/JS chunk 404ing) fire as non-bubbling `error`
    // events targeting the failing <link>/<script> element — only reachable via the
    // capture phase on window, and never carry a message/name (checked by URL instead).
    const onResourceError = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLLinkElement) && !(target instanceof HTMLScriptElement)) return;
      const url = target instanceof HTMLLinkElement ? target.href : target.src;
      if (isStaleBundleResourceError(url)) {
        showToast();
      }
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    window.addEventListener("error", onResourceError, true);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      window.removeEventListener("error", onResourceError, true);
    };
  }, []);

  return null;
}
