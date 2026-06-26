import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { prisma } from "@/lib/prisma";
import { grantTrial, TRIAL_DAYS_PUBLIC } from "@/lib/trial";

type ClerkUserEvent = {
  type: string;
  data: {
    id: string;
    email_addresses: { email_address: string; id: string }[];
    primary_email_address_id: string;
    first_name: string | null;
    last_name: string | null;
    image_url: string | null;
    public_metadata: Record<string, unknown>;
  };
};

export async function POST(req: NextRequest) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CLERK_WEBHOOK_SECRET not configured" }, { status: 500 });
  }

  const svixId = req.headers.get("svix-id") ?? "";
  const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
  const svixSignature = req.headers.get("svix-signature") ?? "";

  const body = await req.text();

  let event: ClerkUserEvent;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkUserEvent;
  } catch {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
  }

  const { type, data } = event;

  if (type === "user.created") {
    const primaryEmail = data.email_addresses.find(
      (e) => e.id === data.primary_email_address_id
    )?.email_address;

    if (!primaryEmail) {
      return NextResponse.json({ error: "No primary email" }, { status: 400 });
    }

    // Check if user already exists (migrated NextAuth user)
    const existing = await prisma.user.findUnique({ where: { email: primaryEmail } });
    if (existing) {
      // Link clerkId to existing user
      await prisma.user.update({
        where: { id: existing.id },
        data: { clerkId: data.id },
      });
    } else {
      // Create brand new user + start their 7-day PRO trial
      const name =
        `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim() ||
        primaryEmail.split("@")[0];
      try {
        const created = await prisma.user.create({
          data: {
            clerkId: data.id,
            name,
            email: primaryEmail,
            image: data.image_url ?? null,
          },
        });
        await grantTrial(created.id, TRIAL_DAYS_PUBLIC);
      } catch {
        // Unique race with the lazy-create in getCurrentUser (first page load can insert the row
        // first) → link clerkId to the existing row instead of 500ing. grantTrial is idempotent
        // (one-trial guard), so no second trial is granted.
        const row = await prisma.user.findFirst({
          where: { OR: [{ email: primaryEmail }, { clerkId: data.id }] },
          select: { id: true },
        });
        if (row) {
          await prisma.user.update({ where: { id: row.id }, data: { clerkId: data.id } }).catch(() => {});
          await grantTrial(row.id, TRIAL_DAYS_PUBLIC).catch(() => {});
        }
      }
    }
  }

  if (type === "user.updated") {
    const user = await prisma.user.findUnique({ where: { clerkId: data.id } });
    if (user) {
      const primaryEmail = data.email_addresses.find(
        (e) => e.id === data.primary_email_address_id
      )?.email_address;
      const name = `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          ...(primaryEmail ? { email: primaryEmail } : {}),
          ...(name ? { name } : {}),
          image: data.image_url ?? undefined,
        },
      });
    }
  }

  if (type === "user.deleted") {
    const user = await prisma.user.findUnique({ where: { clerkId: data.id } });
    if (user) {
      await prisma.user.delete({ where: { id: user.id } });
    }
  }

  return NextResponse.json({ received: true });
}
