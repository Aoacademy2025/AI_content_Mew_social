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
 * This helper cancels that subscription and voids its open and uncollectible
 * invoices, under the plan's "Auto-cancel rules" (a)–(f). Stripe behavior and
 * citations are in docs/research/2026-10-04-stripe-cancel-open-invoices.md.
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

/**
 * Rule (c): the invoice statuses that can still be paid and that Stripe lets us void. An
 * `uncollectible` invoice is no longer auto-collected but can still be paid by hand, so it is
 * voided too. `paid` and `void` are final, and a `draft` cannot be voided.
 */
const VOIDABLE_INVOICE_STATUSES = ["open", "uncollectible"] as const;
type VoidableInvoiceStatus = (typeof VOIDABLE_INVOICE_STATUSES)[number];

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
    retrieve(id: string): Promise<{ status?: string | null; customer?: string | { id: string } | null }>;
    cancel(id: string, params: { invoice_now: boolean; prorate: boolean }): Promise<unknown>;
  };
  invoices: {
    list(params: { subscription: string; status: VoidableInvoiceStatus; limit: number }): AsyncIterable<{
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
  /** A5 hardening: the retrieved subscription's `customer` doesn't match (or the user has no)
   * `stripeCustomerId` on file. A corrupted `stripeSubscriptionId` row must never cancel
   * someone else's subscription. */
  | "customer_mismatch"
  | "stripe_status"
  /** A concurrent run (or someone in the Dashboard) canceled it between our status read and our cancel. */
  | "already_canceled";

export type CancelSupersededStep = "read_db" | "retrieve" | "cancel" | "list_invoices" | "void_invoice";

export type CancelSupersededResult =
  | {
      outcome: "skipped";
      reason: CancelSupersededSkipReason;
      subscriptionId?: string;
      stripeStatus?: string | null;
    }
  | { outcome: "canceled"; subscriptionId: string; voidedInvoiceIds: string[] }
  | {
      outcome: "failed";
      subscriptionId: string | null;
      step: CancelSupersededStep;
      /** Set when the failure is at `void_invoice`: what got voided and what is still payable. */
      voidedInvoiceIds?: string[];
      failedInvoiceIds?: string[];
    };

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
 * one-time PromptPay plan payment, then void its open and uncollectible invoices.
 *
 * Idempotent (rule (d)). A later call finds the subscription `canceled` in
 * Stripe and does nothing. So does a concurrent call whose cancel Stripe
 * refuses because the other call canceled first.
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
  const voidedInvoiceIds: string[] = [];
  const failedInvoiceIds: string[] = [];
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
      select: { stripeSubscriptionId: true, bundleSubscriptionId: true, stripeCustomerId: true },
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

    // A5 hardening: require the subscription Stripe just returned to actually belong to this
    // user's own Stripe customer before we go any further. Guards against a corrupted
    // `stripeSubscriptionId` row pointing at another customer's subscription.
    const subscriptionCustomerId = typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id ?? null;
    if (!user.stripeCustomerId || !subscriptionCustomerId || subscriptionCustomerId !== user.stripeCustomerId) {
      console.error(
        `[cancel-superseded] customer mismatch — user ${userId}, subscription ${subscriptionId}: `
          + `Stripe customer ${subscriptionCustomerId ?? "none"} !== user's stripeCustomerId ${user.stripeCustomerId ?? "none"}`,
      );
      const mismatchAlert: AdminAlert = {
        type: "ERROR_SYSTEM",
        title: "🔴 ERROR: subscription customer ไม่ตรงกับผู้ใช้ ก่อนยกเลิก (PromptPay)",
        body: `ERROR — user ${userId} · subscription ${subscriptionId}`,
      };
      try {
        await (deps.notify ?? notifyAdmins)(mismatchAlert);
      } catch (notifyErr) {
        console.error("[cancel-superseded] admin alert could not be written:", describeError(notifyErr));
      }
      return { outcome: "skipped", reason: "customer_mismatch", subscriptionId };
    }

    // Rule (c): cancel now, with no proration and no final invoice. Canceling also turns off
    // automatic collection on the subscription's open invoices, which stops Smart Retries.
    step = "cancel";
    try {
      await stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false });
    } catch (cancelErr) {
      // Concurrent delivery: two runs (e.g. the original delivery and Stripe's redelivery of the same
      // event) both read past_due, and the other one canceled first, so Stripe refuses ours. That is
      // the outcome we wanted, and the run that canceled voids the invoices. Ask Stripe rather than
      // parse the error text. If that read fails too, the original error is reported below.
      const now = await stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
      if (now?.status === "canceled") {
        console.log(
          `[cancel-superseded] user ${userId}: subscription ${subscriptionId} was already canceled by a concurrent run (checkout ${session.id}); nothing to do`,
        );
        return { outcome: "skipped", reason: "already_canceled", subscriptionId, stripeStatus: "canceled" };
      }
      throw cancelErr;
    }

    // Rule (c): open and uncollectible invoices stay payable after cancel (hosted invoice page,
    // manual charge), so VOID them, which is terminal. Never mark one uncollectible, since that
    // can still be paid. Collect every id first, so no list is mutated while being paginated.
    step = "list_invoices";
    const invoiceIds = new Set<string>();
    for (const status of VOIDABLE_INVOICE_STATUSES) {
      for await (const invoice of stripe.invoices.list({ subscription: subscriptionId, status, limit: INVOICE_PAGE_LIMIT })) {
        if (invoice.status === status && invoice.id) invoiceIds.add(invoice.id);
      }
    }

    // Void each one even if another fails, so as few as possible stay payable. Any failure is
    // reported below with both lists, so an admin knows exactly which invoices still need voiding.
    step = "void_invoice";
    let firstVoidError: unknown = null;
    for (const invoiceId of invoiceIds) {
      try {
        await stripe.invoices.voidInvoice(invoiceId);
        voidedInvoiceIds.push(invoiceId);
      } catch (voidErr) {
        failedInvoiceIds.push(invoiceId);
        firstVoidError ??= voidErr;
        console.error(`[cancel-superseded] could not void invoice ${invoiceId} of ${subscriptionId}: ${describeError(voidErr)}`);
      }
    }
    if (failedInvoiceIds.length > 0) throw firstVoidError;

    console.log(
      `[cancel-superseded] user ${userId}: canceled ${stripeStatus} subscription ${subscriptionId} after PromptPay checkout ${session.id}; voided ${voidedInvoiceIds.length} invoice(s)`,
      voidedInvoiceIds,
    );
    return { outcome: "canceled", subscriptionId, voidedInvoiceIds };
  } catch (err) {
    // Rule (e): the payment and term stay recorded, nothing throws, and admins are told what to do by hand.
    const detail = describeError(err);
    const voidLists = step === "void_invoice"
      ? ` · invoice ที่ void แล้ว: ${voidedInvoiceIds.join(", ") || "ไม่มี"} · invoice ที่ void ไม่สำเร็จ: ${failedInvoiceIds.join(", ")}`
      : "";
    console.error(
      `[cancel-superseded] FAILED at ${step} — user ${userId}, subscription ${subscriptionId ?? "unknown"}, checkout ${session.id}: ${detail}${voidLists}`,
    );
    const alert: AdminAlert = {
      type: "ERROR_SYSTEM",
      title: "🔴 ERROR: ยกเลิก subscription ค้างชำระไม่สำเร็จ หลังลูกค้าจ่าย PromptPay",
      body: `ERROR — user ${userId} · subscription ${subscriptionId ?? "unknown"} · checkout ${session.id} · ขั้นที่ล้ม: ${step} (${detail})${voidLists}. ${SMART_RETRIES_STILL_RUNNING_ALERT}`,
    };
    try {
      await (deps.notify ?? notifyAdmins)(alert);
    } catch (notifyErr) {
      console.error("[cancel-superseded] admin alert could not be written:", describeError(notifyErr));
    }
    return step === "void_invoice"
      ? { outcome: "failed", subscriptionId, step, voidedInvoiceIds, failedInvoiceIds }
      : { outcome: "failed", subscriptionId, step };
  }
}
