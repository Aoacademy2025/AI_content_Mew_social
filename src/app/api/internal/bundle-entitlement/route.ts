import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";
import {
  normalizeBundleEmail,
  recordBundleEntitlement,
  syncStoredBundleEntitlementForUser,
} from "@/lib/bundle-entitlement";
import { syncUserEntitlement } from "@/lib/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Base = z.object({
  email: z.string().email(),
  eventId: z.string().min(1),
  subscriptionId: z.string().min(1).nullable(),
  occurredAt: z.string().datetime(),
});

const Body = z.discriminatedUnion("action", [
  Base.extend({
    action: z.literal("grant"),
    grantId: z.string().min(1),
    expiresAt: z.string().datetime(),
    billingPeriod: z.enum(["monthly", "annual"]),
    amountThb: z.number().int().nonnegative(),
    migrationBackfill: z.boolean().optional(),
  }),
  Base.extend({
    action: z.literal("revoke"),
    reason: z.string().min(1),
  }),
]);

export async function POST(request: Request) {
  const secret = process.env.BUNDLE_SYNC_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization || !timingSafeStrEqual(authorization, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }

  const input = parsed.data.action === "grant"
    ? {
        ...parsed.data,
        occurredAt: new Date(parsed.data.occurredAt),
        expiresAt: new Date(parsed.data.expiresAt),
      }
    : { ...parsed.data, occurredAt: new Date(parsed.data.occurredAt) };
  const result = await recordBundleEntitlement(input);
  const user = await prisma.user.findUnique({
    where: { email: normalizeBundleEmail(parsed.data.email) },
    select: { id: true },
  });
  const applied = user
    ? await syncStoredBundleEntitlementForUser(user.id, new Date(), {
        forcePrimary: parsed.data.action === "grant" && parsed.data.migrationBackfill === true,
      })
    : { changed: false, activated: false };
  if (user && parsed.data.action === "revoke") {
    await syncUserEntitlement(user.id);
  }

  return NextResponse.json({
    ok: true,
    duplicate: result.duplicate,
    stale: result.stale,
    pendingAccount: !user,
    applied: applied.changed,
  });
}
