"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="th">
      <body
        style={{
          alignItems: "center",
          background: "#09090b",
          color: "#fafafa",
          display: "flex",
          fontFamily: "system-ui, sans-serif",
          justifyContent: "center",
          margin: 0,
          minHeight: "100vh",
          padding: 24,
        }}
      >
        <main style={{ maxWidth: 480, textAlign: "center" }}>
          <p style={{ color: "#a1a1aa", marginBottom: 8 }}>HERO AI Studio</p>
          <h1 style={{ fontSize: 28, margin: "0 0 12px" }}>
            ระบบขัดข้องชั่วคราว
          </h1>
          <p style={{ color: "#d4d4d8", lineHeight: 1.6, margin: "0 0 24px" }}>
            ทีมงานได้รับรายงานแล้ว ลองใหม่อีกครั้งได้เลย
          </p>
          <button
            onClick={reset}
            style={{
              background: "#fafafa",
              border: 0,
              borderRadius: 10,
              color: "#18181b",
              cursor: "pointer",
              fontSize: 16,
              fontWeight: 600,
              padding: "12px 20px",
            }}
            type="button"
          >
            ลองอีกครั้ง
          </button>
        </main>
      </body>
    </html>
  );
}
