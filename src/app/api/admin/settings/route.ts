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
  // Plan presentation (name / badge / tagline) — edited by admin, no env fallback
  "plan_free_name",
  "plan_pro_name",
  "plan_business_name",
  "plan_free_badge",
  "plan_pro_badge",
  "plan_business_badge",
  "plan_free_tagline",
  "plan_pro_tagline",
  "plan_business_tagline",
  // Server-owned (platform) API key for internal automation — NOT a user's BYOK
  // key. Used by the loanword miner cron + other server-side Gemini calls.
  "server_gemini_key",
  // Cost-rate config for the Cost & Margin admin dashboard (admin-editable ฿ rates)
  "cost_render_per_minute",
  "cost_image_flux_1k",
  "cost_image_gpt_1k",
  "cost_image_nano_1k",
  "cost_image_gpt_2k",
  "cost_image_nano_2k",
  "cost_video_seedance_5s",
  "cost_infra_monthly",
  "fx_baht_per_usd",
] as const;

type SettingKey = typeof KEYS[number];

// Keys whose values are live secrets (Stripe secret/webhook keys, platform Gemini
// key). These must NEVER be echoed back to the browser in full — GET returns only
// a { set, last4 } sentinel so the admin UI can show status + let them overwrite,
// without ever re-reading the current secret value.
const SECRET_KEYS = new Set<SettingKey>([
  "stripe_secret_key",
  "stripe_webhook_secret",
  "server_gemini_key",
]);

function maskSecret(value: string): { set: boolean; last4?: string } {
  if (!value) return { set: false };
  return { set: true, last4: value.slice(-4) };
}

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
    server_gemini_key: process.env.LOANWORD_MINER_GEMINI_KEY,
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
    server_gemini_key: "LOANWORD_MINER_GEMINI_KEY",
  };
  const envKey = envMap[key];
  if (envKey) process.env[envKey] = value;
  // The platform Gemini key also feeds the SYNC managed resolver (GEMINI_SERVER_KEY),
  // not only the loanword cron — patch it too so an admin save takes effect with no restart.
  if (key === "server_gemini_key") process.env.GEMINI_SERVER_KEY = value;
}

export async function GET() {
  try {
    const authUser = await getCurrentUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({ where: { id: authUser.id }, select: { role: true } });
    if (me?.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const results = await Promise.all(KEYS.map(async k => [k, await getConfig(k)] as const));
    const settings: Record<string, unknown> = {};
    for (const [k, v] of results) {
      settings[k] = SECRET_KEYS.has(k) ? maskSecret(v) : v;
    }

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
