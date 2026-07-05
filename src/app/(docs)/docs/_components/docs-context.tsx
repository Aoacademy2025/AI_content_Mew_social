"use client";

import { createContext, useContext, useEffect, useState } from "react";

export interface DocsContextValue {
  managed: boolean; // true = ระบบจัดการ Gemini ให้ (default = fail-open ไป prod)
}

const DocsContext = createContext<DocsContextValue>({ managed: true });

export function useDocsContext(): DocsContextValue {
  return useContext(DocsContext);
}

export function DocsProvider({ children }: { children: React.ReactNode }) {
  // default managed=true → ถ้า fetch พลาดให้แสดงประสบการณ์ managed (ตรง prod)
  const [managed, setManaged] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      fetch("/api/user/api-keys/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    ]).then(([statusRes]) => {
      if (cancelled) return;
      // `managed` key มีเฉพาะเมื่อ MANAGED_GEMINI=1; ไม่มี = legacy BYOK
      if (statusRes.status === "fulfilled" && statusRes.value) {
        setManaged(statusRes.value.managed === true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  return <DocsContext.Provider value={{ managed }}>{children}</DocsContext.Provider>;
}
