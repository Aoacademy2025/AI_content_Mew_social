import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runDiskWatch } from "@/lib/disk-watch";
import { notifyAdmins } from "@/lib/notifications";
import { sendDiskAlertEmail } from "@/lib/send-email";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/disk-watch — sweep safe junk, then alert admins (in-app + email)
// when disk crosses DISK_ALERT_THRESHOLD (default 80%). Protected by CRON_SECRET
// — fails CLOSED if it's unset.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !timingSafeStrEqual(auth ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { health, swapGb, swept, overThreshold, threshold } = await runDiskWatch();
    const d = health.disk;

    const breakdown = health.directories
      .filter((dir) => dir.exists)
      .sort((a, b) => b.sizeMb - a.sizeMb)
      .map((dir) => `${dir.label}: ${dir.sizeGb} GB`);
    if (swapGb > 0) breakdown.push(`Swap: ${swapGb} GB`);

    if (overThreshold) {
      const title = `⚠️ ดิสก์ใกล้เต็ม ${d.usedPercent}% (เหลือ ${d.availableGb} GB)`;
      const body = [
        `ดิสก์ ${d.mount} ใช้ไป ${d.usedGb} / ${d.totalGb} GB (${d.usedPercent}%) — เกิน ${threshold}%`,
        "",
        "แยกตามหมวด:",
        ...breakdown,
        swept.freedMb > 0 ? `\nกวาดอัตโนมัติแล้ว ${swept.freedMb} MB (${swept.items.length} รายการ)` : "",
      ]
        .filter(Boolean)
        .join("\n");

      await notifyAdmins({ type: "ERROR_SYSTEM", title, body });

      const cfg = await prisma.siteConfig.findUnique({ where: { key: "support_email" } });
      const to = (cfg?.value || process.env.SUPPORT_EMAIL || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (to.length) {
        await sendDiskAlertEmail({
          to,
          mount: d.mount,
          usedPercent: d.usedPercent,
          usedGb: d.usedGb,
          totalGb: d.totalGb,
          availableGb: d.availableGb,
          breakdown,
          sweptMb: swept.freedMb,
        });
      }
    }

    console.log(
      `[disk-watch] ${new Date().toISOString()} used=${d.usedPercent}% avail=${d.availableGb}GB ` +
        `status=${health.status} swept=${swept.freedMb}MB alerted=${overThreshold}`,
    );

    return NextResponse.json({
      ok: true,
      usedPercent: d.usedPercent,
      availableGb: d.availableGb,
      status: health.status,
      threshold,
      overThreshold,
      sweptMb: swept.freedMb,
      sweptItems: swept.items.length,
    });
  } catch (error) {
    console.error("[disk-watch] failed:", error);
    return NextResponse.json({ error: "disk-watch failed" }, { status: 500 });
  }
}
