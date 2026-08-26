"use client";

/**
 * ModelExplainerPanel — แสดงคำอธิบายโมเดลการใช้งาน HERO AI สำหรับผู้ใช้ใหม่
 *
 * Flag-off proof:
 * - minuteQuota=false + managed=false + NEXT_PUBLIC_CREDITS_LIVE !== "1"
 *   → hasClauses = false → returns null → ไม่มี DOM เพิ่มเติม (byte-identical ต่อหน้า)
 *
 * Each clause is individually gated:
 * - minutes clause  → gated on minuteQuota (MINUTE_QUOTA=1 server flag → API returns { minuteQuota: true })
 * - managed clause  → gated on managed    (MANAGED_GEMINI=1 server flag → API returns { managed: true })
 * - stock clause    → gated on managedStock (MANAGED_STOCK=1 server flag → API returns { managedStock: true },
 *                     or the build-baked NEXT_PUBLIC_MANAGED_STOCK mirror) — issue #297
 * - credits clause  → gated on NEXT_PUBLIC_CREDITS_LIVE==="1" (build-baked)
 */

const CREDITS_LIVE = process.env.NEXT_PUBLIC_CREDITS_LIVE === "1";

interface Props {
  managed: boolean;
  minuteQuota: boolean;
  minutesForPlan: number | null; // null = not yet loaded
  managedStock?: boolean;
}

export function ModelExplainerPanel({ managed, minuteQuota, minutesForPlan, managedStock = false }: Props) {
  const showMinutes = minuteQuota;
  const showManaged = managed;
  const showManagedStock = managedStock;
  const showCredits = CREDITS_LIVE;

  const hasClauses = showMinutes || showManaged || showManagedStock || showCredits;
  if (!hasClauses) return null;

  const minuteLabel = minuteQuota && minutesForPlan != null
    ? `${minutesForPlan} นาที/เดือน`
    : "นาทีต่อเดือนตามแพ็กเกจ";

  return (
    <div className="mb-4 rounded-xl border border-sky-500/20 bg-sky-950/30 px-4 py-3 text-sm text-sky-200">
      <p className="mb-1.5 font-semibold text-sky-100">วิธีใช้งาน HERO AI</p>
      <ul className="space-y-1 text-sky-300/90">
        {showMinutes && (
          <li>• คุณมี <span className="font-medium text-sky-100">{minuteLabel}</span> สำหรับสร้างวิดีโอ</li>
        )}
        {showManaged && (
          <li>
            {showManagedStock
              ? "• ระบบจัดการ AI (Gemini) ให้ — ไม่ต้องตั้งค่า key เอง"
              : "• ระบบจัดการ AI (Gemini) ให้ — ไม่ต้องตั้งค่า key เอง ใส่แค่ Pexels/Pixabay สำหรับ B-roll"}
          </li>
        )}
        {showManagedStock && (
          <li>• คลังสต็อก B-roll: ใช้ของระบบได้เลย — Pexels/Pixabay key ของคุณเอง <span className="font-medium text-sky-100">ไม่บังคับ</span> (ใส่แล้วเลือกภาพได้มากขึ้น)</li>
        )}
        {showCredits && (
          <li>• ใช้เกินโควต้านาที? <span className="font-medium text-sky-100">ซื้อเครดิตเติมได้</span></li>
        )}
      </ul>
    </div>
  );
}
