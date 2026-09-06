import { revalidatePath } from "next/cache";
import { Monitor } from "lucide-react";
import { getCurrentUser } from "@/lib/clerk-auth";
import { isDesktopEnabled, isDesktopInvited } from "@/lib/desktop/flag";
import { prisma } from "@/lib/prisma";

async function revokeOwnDesktopSeat(seatId: string) {
  "use server";
  const user = await getCurrentUser();
  if (!user || !isDesktopEnabled() || !isDesktopInvited(user.id)) return;
  await prisma.deviceSeat.updateMany({
    where: { id: seatId, userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  revalidatePath("/settings");
}

export async function DesktopDevicesSection() {
  const user = await getCurrentUser();
  if (!user || !isDesktopEnabled() || !isDesktopInvited(user.id)) return null;

  const seats = await prisma.deviceSeat.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, name: true, platform: true, lastSeenAt: true },
  });

  return (
    <div className="ve-card rounded-xl p-7">
      <div className="flex items-center gap-3 mb-6 pb-5 border-b border-white/5">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-xl"
          style={{
            background: "hsl(var(--accent-primary) / 0.1)",
            border: "1px solid hsl(var(--accent-primary) / 0.2)",
          }}
        >
          <Monitor className="h-4 w-4" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.25} />
        </div>
        <div>
          <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
            อุปกรณ์ที่ล็อกอิน
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
            เครื่องที่เปิดแอปเดสก์ท็อปอยู่ — ลบแล้วเครื่องนั้นจะออกจากระบบ
          </p>
        </div>
      </div>

      {seats.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ยังไม่มีอุปกรณ์ที่ล็อกอิน</p>
      ) : (
        <ul className="space-y-2">
          {seats.map((seat) => (
            <li
              key={seat.id}
              className="flex items-center gap-3 rounded-xl px-3 py-3"
              style={{ background: "hsl(0 0% 100% / 0.03)", border: "1px solid hsl(0 0% 100% / 0.06)" }}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: "var(--ui-text-primary)" }}>
                  {seat.name}
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
                  {seat.platform} · เห็นล่าสุด{" "}
                  {seat.lastSeenAt.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}
                </p>
              </div>
              <form action={revokeOwnDesktopSeat.bind(null, seat.id)}>
                <button
                  type="submit"
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-red-500/10 hover:text-red-400"
                  style={{ color: "var(--ui-text-muted)", border: "1px solid hsl(0 0% 100% / 0.08)" }}
                >
                  ลบ
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
