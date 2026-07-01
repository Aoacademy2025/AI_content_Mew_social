"use client";

import { createContext, useContext, useEffect, useState } from "react";

export interface DocsContextValue {
  managed: boolean; // true = ระบบจัดการ Gemini ให้ (default = fail-open ไป prod)
  plan: string;     // "FREE" | "PRO" | "BUSINESS"
  loading: boolean;
}

const DocsContext = createContext<DocsContextValue>({ managed: true, plan: "FREE", loading: true });

export function useDocsContext(): DocsContextValue {
  return useContext(DocsContext);
}

export function DocsProvider({ children }: { children: React.ReactNode }) {
  // default managed=true → ถ้า fetch พลาดให้แสดงประสบการณ์ managed (ตรง prod)
  const [managed, setManaged] = useState(true);
  const [plan, setPlan] = useState("FREE");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      fetch("/api/user/api-keys/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/user/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    ]).then(([statusRes, meRes]) => {
      if (cancelled) return;
      // `managed` key มีเฉพาะเมื่อ MANAGED_GEMINI=1; ไม่มี = legacy BYOK
      if (statusRes.status === "fulfilled" && statusRes.value) {
        setManaged(statusRes.value.managed === true);
      }
      if (meRes.status === "fulfilled" && meRes.value?.plan) {
        setPlan(String(meRes.value.plan));
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return <DocsContext.Provider value={{ managed, plan, loading }}>{children}</DocsContext.Provider>;
}
