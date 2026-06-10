import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { resetStripeClient } from "@/lib/stripe";

const KEYS = [
  "support_email",
  "stripe_publishable_key",
  "stripe_secret_key",
  "stripe_webhook_secret",
  "stripe_price_pro",
  "stripe_price_business",
  "plan_free_price",
  "plan_free_features",
  "plan_pro_price",
  "plan_pro_features",
  "plan_business_price",
  "plan_business_features",
] as const;

type SettingKey = typeof KEYS[number];

async function getConfig(key: SettingKey): Promise<string> {
  const row = await prisma.siteConfig.findUnique({ where: { key } });
  if (row) return row.value;
  // fallback to env
  const envMap: Partial<Record<SettingKey, string | undefined>> = {
    support_email: process.env.SUPPORT_EMAIL,
    stripe_publishable_key: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    stripe_secret_key: process.env.STRIPE_SECRET_KEY,
    stripe_webhook_secret: process.env.STRIPE_WEBHOOK_SECRET,
    stripe_price_pro: process.env.STRIPE_PRICE_PRO_MONTHLY,
    stripe_price_business: process.env.STRIPE_PRICE_BUSINESS_MONTHLY,
  };
  return envMap[key] ?? "";
}

async function setConfig(key: SettingKey, value: string) {
  await prisma.siteConfig.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  // also patch runtime env
  const envMap: Partial<Record<SettingKey, string>> = {
    support_email: "SUPPORT_EMAIL",
    stripe_publishable_key: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    stripe_secret_key: "STRIPE_SECRET_KEY",
    stripe_webhook_secret: "STRIPE_WEBHOOK_SECRET",
    stripe_price_pro: "STRIPE_PRICE_PRO_MONTHLY",
    stripe_price_business: "STRIPE_PRICE_BUSINESS_MONTHLY",
  };
  const envKey = envMap[key];
  if (envKey) process.env[envKey] = value;
}

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({ where: { id: authUser.id }, select: { role: true } });
    if (me?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const results = await Promise.all(KEYS.map(async k => [k, await getConfig(k)]));
    const settings = Object.fromEntries(results);

    return NextResponse.json(settings);
  } catch (error) {
    return apiError({ route: "GET /api/admin/settings", error });
  }
}

export async function PATCH(req: Request) {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({ where: { id: authUser.id }, select: { role: true } });
    if (me?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();

    for (const key of KEYS) {
      if (key in body && body[key] !== undefined) {
        await setConfig(key, String(body[key]));
      }
    }

    // If Stripe keys were updated, reset the cached client so next call uses new key
    if ("stripe_secret_key" in body || "stripe_price_pro" in body || "stripe_price_business" in body) {
      resetStripeClient();
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError({ route: "PATCH /api/admin/settings", error });
  }
}
