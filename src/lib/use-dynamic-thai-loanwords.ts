"use client";

import { useEffect, useState } from "react";
import { setDynamicLoanwords } from "@/lib/thai-loanwords";
import { setDynamicCompounds } from "@/lib/thai-compounds";

/**
 * Hydrates dynamic Thai loanwords & approved compounds from `/api/thai-loanwords`
 * into the client-side word-break singletons (`setDynamicLoanwords` /
 * `setDynamicCompounds`). Fail-open: static seeds stay active if the fetch fails.
 *
 * Returns a revision counter that increments once hydrated so preview components
 * re-render with the freshly loaded word-break set.
 */
export function useDynamicThaiLoanwords(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/thai-loanwords")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const deny = Array.isArray(d.denylist) ? d.denylist : [];
        if (Array.isArray(d.words)) setDynamicLoanwords(d.words, deny);
        if (Array.isArray(d.compounds)) setDynamicCompounds(d.compounds, deny);
        setRevision((v) => v + 1);
      })
      .catch(() => {
        /* fail-open: static lists only */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return revision;
}
