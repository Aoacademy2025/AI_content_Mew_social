import { prisma } from "@/lib/prisma";
import { notifyAdmins } from "@/lib/notifications";
import { promptpayMonthlyEnabled } from "@/lib/promptpay-monthly";

/**
 * A customer whose card subscription is past due pays a PromptPay term instead
 * (ADR 0066, docs/plans/2026-10-04-promptpay-monthly.md Task 3). From then on
 * the card subscription must stop collecting. Otherwise Smart Retries can still
 * charge the card once it has funds, and the `invoice.paid` webhook overwrites
 * `planExpiresAt` with that subscription's period end, replacing the term the
 * customer paid for.
 *
 * This helper cancels that subscription and voids its open invoices, under the
 * plan's "Auto-cancel rules" (a)–(f). Stripe behavior and citations are in
 * docs/research/2026-10-04-stripe-cancel-open-invoices.md.
 *
 * It never throws. It runs after the paid term is already committed, and a
 * throw there would make the webhook retry and re-run work that must happen
 * exactly once. A failure is reported to admins, and the term is never rolled
 * back.
 */

/** Rule (e): the admin instruction, verbatim. */
export const SMART_RETRIES_STILL_RUNNING_ALERT =
  "Smart Retries ยังทำงาน — ยกเลิก subscription นี้ใน Stripe ทันที ไม่งั้น invoice.paid จะเขียนทับวันหมดอายุที่ลูกค้าจ่าย PromptPay";

/** Rule (b): the only Stripe statuses acted on. Anything else is left alone. */
const SUPERSEDABLE_STRIPE_STATUSES: ReadonlySet<string> = new Set(["past_due", "unpaid"]);

/** Stripe's max page size for `invoices.list`. */
const INVOICE_PAGE_LIMIT = 100;
const MAX_ERROR_DETAIL = 300;

/**
 * The four Stripe calls this helper may make. The real `Stripe` client fits this
 * shape; tests pass a stub. Note there is deliberately no `markUncollectible`:
 * an uncollectible invoice can still be paid (rule (c)).
 */
export type SupersedeStripeClient = {
  subscriptions: {
    retrieve(id: string): Promise<{ status?: string | null }>;
    cancel(id: string, params: { invoice_now: boolean; prorate: boolean }): Promise<unknown>;
  };
  invoices: {
    list(params: { subscription: string; status: "open"; limit: number }): AsyncIterable<{
      id?: string | null;
      status?: string | null;
    }>;
    voidInvoice(id: string): Promise<unknown>;
  };
};

/** The Checkout Session fields rule (a) reads. The webhook passes the event object as is. */
export type SupersedingCheckoutSession = {
  id: string;
  mode?: string | null;
  payment_status?: string | null;
  metadata?: Record<string, string | undefined> | null;
};

type AdminAlert = { type: "ERROR_SYSTEM"; title: string; body: string };

export type CancelSupersededDeps = {
  /** For tests. Production reads `process.env` through `promptpayMonthlyEnabled`. */
  env?: Record<string, string | undefined>;
  /** For tests. Production writes the admin notification through `notifyAdmins`. */
  notify?: (alert: AdminAlert) => Promise<unknown>;
};

export type CancelSupersededSkipReason =
  | "flag_off"
  | "not_one_time"
  | "not_plan_payment"
  | "not_paid"
  | "payment_not_recorded"
  | "no_subscription"
  | "bundle_subscription"
  | "stripe_status";

export type CancelSupersededStep = "read_db" | "retrieve" | "cancel" | "list_open_invoices" | "void_invoice";

export type CancelSupersededResult =
  | {
      outcome: "skipped";
      reason: CancelSupersededSkipReason;
      subscriptionId?: string;
      stripeStatus?: string | null;
    }
  | { outcome: "canceled"; subscriptionId: string; voidedInvoiceIds: string[] }
  | { outcome: "failed"; subscriptionId: string | null; step: CancelSupersededStep };

function isPaidTier(plan: unknown): boolean {
  return plan === "PRO" || plan === "BUSINESS";
}

function describeError(err: unknown): string {
  const text = err instanceof Error
    ? `${(err as { type?: unknown }).type ?? err.name}: ${err.message}`
    : String(err);
  return text.length > MAX_ERROR_DETAIL ? `${text.slice(0, MAX_ERROR_DETAIL)}…` : text;
}

/**
 * Cancel the user's own past-due/unpaid Stripe subscription after a settled
 * one-time PromptPay plan payment, then void its open invoices.
 *
 * Idempotent (rule (d)). A second call finds the subscription `canceled` in
 * Stripe and does nothing.
 */
export async function cancelSupersededSubscription(
  stripe: SupersedeStripeClient,
  session: SupersedingCheckoutSession,
  deps: CancelSupersededDeps = {},
): Promise<CancelSupersededResult> {
  // Gate first. Flag off means no DB read and no Stripe call, so the webhook behaves exactly as before.
  if (!promptpayMonthlyEnabled(deps.env)) return { outcome: "skipped", reason: "flag_off" };

  // Rule (a): a one-time PLAN payment (never a credit pack), and only once Stripe says it is paid.
  // An unpaid `checkout.session.completed` (PromptPay not yet scanned) stops here.
  // Annual PromptPay terms qualify as well (rule (f)): the period is not checked.
  const metadata = session.metadata ?? {};
  if (session.mode !== "payment") return { outcome: "skipped", reason: "not_one_time" };
  if (metadata.type === "credits" || !metadata.userId || !isPaidTier(metadata.plan)) {
    return { outcome: "skipped", reason: "not_plan_payment" };
  }
  if (session.payment_status !== "paid") return { outcome: "skipped", reason: "not_paid" };

  const userId = metadata.userId;
  let subscriptionId: string | null = null;
  let step: CancelSupersededStep = "read_db";
  try {
    // Act only when OUR ledger already holds this session as this user's PAID plan payment.
    // Then the subscription is never canceled without the term that replaces it already recorded.
    const payment = await prisma.payment.findUnique({
      where: { stripeSessionId: session.id },
      select: { status: true, userId: true },
    });
    if (payment?.status !== "PAID" || payment.userId !== userId) {
      return { outcome: "skipped", reason: "payment_not_recorded" };
    }

    // Rule (b): target only this user's own `stripeSubscriptionId`, never another sub of the same customer.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stripeSubscriptionId: true, bundleSubscriptionId: true },
    });
    subscriptionId = user?.stripeSubscriptionId ?? null;
    if (!user || !subscriptionId) return { outcome: "skipped", reason: "no_subscription" };

    // Rule (b): never touch a Hero AI Bundle subscription. These are the same markers the
    // `customer.subscription.updated` webhook and the Bundle sync use.
    const bundle = user.bundleSubscriptionId === subscriptionId
      || !!(await prisma.bundleEntitlement.findFirst({ where: { subscriptionId }, select: { email: true } }));
    if (bundle) return { outcome: "skipped", reason: "bundle_subscription", subscriptionId };

    // Rule (b): Stripe's own status decides, not our cached `subStatus`.
    step = "retrieve";
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const stripeStatus = subscription.status ?? null;
    if (!stripeStatus || !SUPERSEDABLE_STRIPE_STATUSES.has(stripeStatus)) {
      return { outcome: "skipped", reason: "stripe_status", subscriptionId, stripeStatus };
    }

    // Rule (c): cancel now, with no proration and no final invoice. Canceling also turns off
    // automatic collection on the subscription's open invoices, which stops Smart Retries.
    step = "cancel";
    await stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false });

    // Rule (c): an open invoice stays payable after cancel (hosted invoice page, manual charge),
    // so VOID it, which is terminal. Never mark it uncollectible, since that can still be paid.
    // Collect the ids before voiding, so the list is not mutated while being paginated.
    step = "list_open_invoices";
    const openInvoiceIds: string[] = [];
    for await (const invoice of stripe.invoices.list({
      subscription: subscriptionId,
      status: "open",
      limit: INVOICE_PAGE_LIMIT,
    })) {
      if (invoice.status === "open" && invoice.id) openInvoiceIds.push(invoice.id);
    }
    step = "void_invoice";
    const voidedInvoiceIds: string[] = [];
    for (const invoiceId of openInvoiceIds) {
      await stripe.invoices.voidInvoice(invoiceId);
      voidedInvoiceIds.push(invoiceId);
    }

    console.log(
      `[cancel-superseded] user ${userId}: canceled ${stripeStatus} subscription ${subscriptionId} after PromptPay checkout ${session.id}; voided ${voidedInvoiceIds.length} open invoice(s)`,
      voidedInvoiceIds,
    );
    return { outcome: "canceled", subscriptionId, voidedInvoiceIds };
  } catch (err) {
    // Rule (e): the payment and term stay recorded, nothing throws, and admins are told what to do by hand.
    const detail = describeError(err);
    console.error(
      `[cancel-superseded] FAILED at ${step} — user ${userId}, subscription ${subscriptionId ?? "unknown"}, checkout ${session.id}: ${detail}`,
    );
    const alert: AdminAlert = {
      type: "ERROR_SYSTEM",
      title: "🔴 ERROR: ยกเลิก subscription ค้างชำระไม่สำเร็จ หลังลูกค้าจ่าย PromptPay",
      body: `ERROR — user ${userId} · subscription ${subscriptionId ?? "unknown"} · checkout ${session.id} · ขั้นที่ล้ม: ${step} (${detail}). ${SMART_RETRIES_STILL_RUNNING_ALERT}`,
    };
    try {
      await (deps.notify ?? notifyAdmins)(alert);
    } catch (notifyErr) {
      console.error("[cancel-superseded] admin alert could not be written:", describeError(notifyErr));
    }
    return { outcome: "failed", subscriptionId, step };
  }
}
