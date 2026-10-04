// Proof for docs/plans/2026-10-04-promptpay-monthly.md, Task 3 (ADR 0066):
// after a SETTLED one-time PromptPay plan payment, a Stripe subscription of the
// same user that Stripe itself reports as past_due/unpaid is canceled (no
// proration, no final invoice) and its open invoices are voided.
//
// A. cancelSupersededSubscription with an injected Stripe stub (rules (a)–(f))
// B. the real webhook POST handler, signed events, the cached Stripe client's
//    methods replaced by the same stub: the settled path, the `already_paid`
//    retry path, a Stripe failure, a credit pack, flag off, and the
//    customer.subscription.deleted event Stripe sends after our cancel
// C. source-text checks: route wiring on both paths, the deleted handler only
//    clears subscription fields, the flag is read through the one helper
//
// Stripe is NEVER called. The fake secret key below is not a real key, the
// client's HTTP layer is replaced by one that refuses every request, and the
// script asserts at the end that it was never reached.
//
// Run: node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-cancel-superseded-subscription.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Stripe from "stripe";

const dir = mkdtempSync(join(tmpdir(), "cancel-superseded-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.STRIPE_SECRET_KEY = "sk_test_cancel_superseded_verification_not_real";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_cancel_superseded_verification";
process.env.STRIPE_PRICE_PRO_MONTHLY = "price_test_pro_month";
process.env.STRIPE_PRICE_PRO_ANNUAL = "price_test_pro_year";
process.env.STRIPE_PRICE_PRO_ANNUAL_ONETIME = "price_test_pro_promptpay_year";
process.env.STRIPE_PRICE_PRO_MONTHLY_ONETIME = "price_test_pro_promptpay_month";
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = "price_test_business_month";
process.env.STRIPE_PRICE_BUSINESS_ANNUAL = "price_test_business_year";
process.env.STRIPE_PRICE_BUSINESS_ANNUAL_ONETIME = "price_test_business_promptpay_year";
process.env.STRIPE_PRICE_BUSINESS_MONTHLY_ONETIME = "price_test_business_promptpay_month";
process.env.STRIPE_PORTAL_FOUNDING_ANNUAL_CONFIG_ID = "bpc_test";
process.env.CREDITS_LIVE = "0";
process.env.MINUTE_QUOTA = "0";
delete process.env.PRESERVE_TRIAL_ON_CONVERT;
delete process.env.PROMPTPAY_MONTHLY;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { stdio: "ignore", env: process.env });

const REQUIRED_ALERT =
  "Smart Retries ยังทำงาน — ยกเลิก subscription นี้ใน Stripe ทันที ไม่งั้น invoice.paid จะเขียนทับวันหมดอายุที่ลูกค้าจ่าย PromptPay";
const FLAG_ON = { PROMPTPAY_MONTHLY: "1" };
const FLAG_OFF = {};
const DAY_MS = 24 * 60 * 60 * 1000;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// ── The Stripe stub ─────────────────────────────────────────────────────────
// Shaped like the four stripe-node calls the helper may make. `list` returns an
// async iterable (stripe-node's ApiListPromise is an AsyncIterableIterator) and
// filters like Stripe does, so a helper that forgets `status: "open"` or the
// subscription filter would void the wrong invoices and fail below.
type StubSub = { status: string; customer: string };
type StubInvoice = { id: string; subscription: string; status: string };
type Call = { op: string; id?: string; params?: unknown };
type FailOn = "retrieve" | "cancel" | "list" | "void" | null;

class StubStripeError extends Error {
  type = "StripeAPIError";
  constructor(message: string) { super(message); }
}

function makeStub(subs: Record<string, StubSub>, invoices: StubInvoice[]) {
  const calls: Call[] = [];
  let failOn: FailOn = null;
  const fail = (op: FailOn) => {
    if (failOn === op) throw new StubStripeError(`stub: ${op} failed (simulated Stripe outage)`);
  };
  const api = {
    subscriptions: {
      async retrieve(id: string) {
        calls.push({ op: "retrieve", id });
        fail("retrieve");
        const sub = subs[id];
        if (!sub) throw new StubStripeError(`No such subscription: '${id}'`);
        return { id, object: "subscription", status: sub.status, customer: sub.customer };
      },
      async cancel(id: string, params?: unknown) {
        calls.push({ op: "cancel", id, params });
        fail("cancel");
        const sub = subs[id];
        if (!sub) throw new StubStripeError(`No such subscription: '${id}'`);
        if (sub.status === "canceled") throw new StubStripeError(`subscription ${id} is already canceled`);
        sub.status = "canceled";
        return { id, object: "subscription", status: "canceled", customer: sub.customer };
      },
    },
    invoices: {
      list(params: { subscription?: string; status?: string; limit?: number }) {
        calls.push({ op: "list", params });
        const matching = invoices.filter((inv) =>
          (params.subscription === undefined || inv.subscription === params.subscription)
          && (params.status === undefined || inv.status === params.status));
        const failing = failOn === "list";
        return (async function* () {
          if (failing) throw new StubStripeError("stub: list failed (simulated Stripe outage)");
          for (const inv of matching) {
            yield {
              id: inv.id,
              object: "invoice",
              status: inv.status,
              parent: { subscription_details: { subscription: inv.subscription } },
            };
          }
        })();
      },
      async voidInvoice(id: string) {
        calls.push({ op: "void", id });
        fail("void");
        const inv = invoices.find((candidate) => candidate.id === id);
        if (!inv) throw new StubStripeError(`No such invoice: '${id}'`);
        if (inv.status !== "open" && inv.status !== "uncollectible") {
          throw new StubStripeError(`invoice ${id} is ${inv.status} and cannot be voided`);
        }
        inv.status = "void";
        return { id, object: "invoice", status: "void" };
      },
      async markUncollectible(id: string) {
        calls.push({ op: "markUncollectible", id });
        throw new StubStripeError("markUncollectible must never be called");
      },
    },
  };
  return {
    api,
    calls,
    subs,
    invoices,
    setFailOn(op: FailOn) { failOn = op; },
    ops: () => calls.map((c) => c.op),
    reset() { calls.length = 0; failOn = null; },
  };
}

type Notified = { type: string; title: string; body: string };
function recordingNotify() {
  const sent: Notified[] = [];
  return {
    sent,
    notify: async (input: Notified) => { sent.push(input); },
  };
}

function src(path: string): string {
  return readFileSync(path, "utf8");
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { cancelSupersededSubscription } = await import("../src/lib/cancel-superseded-subscription");

  const now = new Date();
  let seq = 0;

  /** A user whose plan payment for `sessionId` is already recorded PAID (activation committed). */
  async function paidUser(opts: {
    stripeSubscriptionId: string | null;
    subStatus?: string | null;
    sessionId: string;
    bundleSubscriptionId?: string | null;
    paymentStatus?: "PAID" | "PENDING";
    periodDays?: number;
  }) {
    seq += 1;
    const id = `user-${seq}`;
    await prisma.user.create({
      data: {
        id,
        name: `User ${seq}`,
        email: `user-${seq}@example.com`,
        plan: "PRO",
        planExpiresAt: new Date(now.getTime() + 30 * DAY_MS),
        stripeCustomerId: `cus_${seq}`,
        stripeSubscriptionId: opts.stripeSubscriptionId,
        subStatus: opts.subStatus === undefined ? "past_due" : opts.subStatus,
        bundleSubscriptionId: opts.bundleSubscriptionId ?? null,
      },
    });
    await prisma.payment.create({
      data: {
        userId: id,
        stripeSessionId: opts.sessionId,
        plan: "PRO",
        amount: 59900,
        currency: "thb",
        status: opts.paymentStatus ?? "PAID",
        periodDays: opts.periodDays ?? 30,
        paidAt: opts.paymentStatus === "PENDING" ? null : now,
      },
    });
    return id;
  }

  function promptpaySession(id: string, userId: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      amount_total: 59900,
      currency: "thb",
      metadata: { userId, plan: "PRO", period: "monthly", periodDays: "30", method: "promptpay" },
      ...overrides,
    };
  }

  // ═══ A · the helper, Stripe injected ══════════════════════════════════════
  console.log("\nA. cancelSupersededSubscription with an injected Stripe stub");

  // A1 · past_due → canceled with no proration and no final invoice; every open invoice voided
  {
    const userId = await paidUser({ stripeSubscriptionId: "sub_a1", sessionId: "cs_a1" });
    const stub = makeStub(
      { sub_a1: { status: "past_due", customer: "cus_a1" } },
      [
        { id: "in_a1_open_1", subscription: "sub_a1", status: "open" },
        { id: "in_a1_open_2", subscription: "sub_a1", status: "open" },
        { id: "in_a1_open_3", subscription: "sub_a1", status: "open" },
        { id: "in_a1_paid", subscription: "sub_a1", status: "paid" },
        { id: "in_a1_void", subscription: "sub_a1", status: "void" },
        { id: "in_other_sub_open", subscription: "sub_somebody_else", status: "open" },
      ],
    );
    const n = recordingNotify();
    const result = await cancelSupersededSubscription(stub.api, promptpaySession("cs_a1", userId), { env: FLAG_ON, notify: n.notify });
    check("A1 past_due: Stripe status is read first, then cancel, then open invoices listed and voided",
      isDeepStrictEqual(stub.ops(), ["retrieve", "cancel", "list", "void", "void", "void"]), JSON.stringify(stub.calls));
    const cancel = stub.calls.find((c) => c.op === "cancel");
    check("A1 cancel targets the user's own sub id with exactly { invoice_now: false, prorate: false }",
      cancel?.id === "sub_a1" && isDeepStrictEqual(cancel?.params, { invoice_now: false, prorate: false }),
      JSON.stringify(cancel));
    const list = stub.calls.find((c) => c.op === "list");
    check("A1 open invoices are listed for that subscription only, status open, max page size",
      isDeepStrictEqual(list?.params, { subscription: "sub_a1", status: "open", limit: 100 }), JSON.stringify(list));
    check("A1 exactly the three open invoices of that subscription are voided",
      stub.invoices.filter((i) => i.status === "void").map((i) => i.id).sort().join(",")
        === "in_a1_open_1,in_a1_open_2,in_a1_open_3,in_a1_void"
      && stub.invoices.find((i) => i.id === "in_a1_paid")?.status === "paid"
      && stub.invoices.find((i) => i.id === "in_other_sub_open")?.status === "open");
    check("A1 the subscription is canceled in Stripe", stub.subs.sub_a1.status === "canceled");
    check("A1 result reports canceled + the voided invoice ids",
      result.outcome === "canceled" && result.subscriptionId === "sub_a1"
        && isDeepStrictEqual([...result.voidedInvoiceIds].sort(), ["in_a1_open_1", "in_a1_open_2", "in_a1_open_3"]),
      JSON.stringify(result));
    check("A1 never marks anything uncollectible", !stub.ops().includes("markUncollectible"));
    check("A1 no admin alert on success", n.sent.length === 0);

    // A8 · retry after success → no-op (reads Stripe status, changes nothing)
    stub.reset();
    const again = await cancelSupersededSubscription(stub.api, promptpaySession("cs_a1", userId), { env: FLAG_ON, notify: n.notify });
    check("A8 retry after success: only a status read, no cancel/list/void",
      isDeepStrictEqual(stub.ops(), ["retrieve"]), JSON.stringify(stub.calls));
    check("A8 retry after success reports skipped (Stripe says canceled), no alert",
      again.outcome === "skipped" && again.reason === "stripe_status" && n.sent.length === 0, JSON.stringify(again));
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const payment = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_a1" } });
    check("A1 the helper writes nothing to the user or payment (the deleted webhook owns the DB side)",
      user?.stripeSubscriptionId === "sub_a1" && user?.plan === "PRO" && payment?.status === "PAID");
  }

  // A2 · unpaid → canceled + voided; this session is an ANNUAL PromptPay term (rule (f))
  {
    const userId = await paidUser({ stripeSubscriptionId: "sub_a2", sessionId: "cs_a2", subStatus: "past_due", periodDays: 365 });
    const stub = makeStub(
      { sub_a2: { status: "unpaid", customer: "cus_a2" } },
      [{ id: "in_a2_open", subscription: "sub_a2", status: "open" }],
    );
    const n = recordingNotify();
    const result = await cancelSupersededSubscription(
      stub.api,
      promptpaySession("cs_a2", userId, {
        amount_total: 599000,
        metadata: { userId, plan: "PRO", period: "annual", periodDays: "365", method: "promptpay" },
      }),
      { env: FLAG_ON, notify: n.notify },
    );
    check("A2 unpaid (annual PromptPay, rule f): canceled and the open invoice voided",
      result.outcome === "canceled" && stub.subs.sub_a2.status === "canceled"
        && stub.invoices[0].status === "void" && isDeepStrictEqual(stub.ops(), ["retrieve", "cancel", "list", "void"]),
      JSON.stringify({ result, calls: stub.calls }));
  }

  // A3 · the app says past_due but Stripe says active → untouched
  // A4 · trialing / canceled / incomplete / paused → untouched
  for (const status of ["active", "trialing", "canceled", "incomplete", "paused"]) {
    const subId = `sub_a3_${status}`;
    const userId = await paidUser({ stripeSubscriptionId: subId, sessionId: `cs_a3_${status}`, subStatus: "past_due" });
    const stub = makeStub(
      { [subId]: { status, customer: "cus_a3" } },
      [{ id: `in_a3_${status}`, subscription: subId, status: "open" }],
    );
    const n = recordingNotify();
    const result = await cancelSupersededSubscription(stub.api, promptpaySession(`cs_a3_${status}`, userId), { env: FLAG_ON, notify: n.notify });
    check(`A3/A4 app says past_due, Stripe says ${status} → status read only, untouched`,
      isDeepStrictEqual(stub.ops(), ["retrieve"]) && stub.subs[subId].status === status
        && stub.invoices[0].status === "open" && result.outcome === "skipped" && n.sent.length === 0,
      JSON.stringify({ result, calls: stub.calls }));
  }

  // A5 · Bundle subscriptions → untouched, not even read from Stripe
  {
    const userId = await paidUser({ stripeSubscriptionId: "sub_bundle_entitlement", sessionId: "cs_a5_entitlement" });
    await prisma.bundleEntitlement.create({
      data: {
        email: "bundle-owner@example.com",
        grantId: "in_bundle_grant",
        subscriptionId: "sub_bundle_entitlement",
        status: "ACTIVE",
        accessEndsAt: new Date(now.getTime() + 30 * DAY_MS),
        billingPeriod: "monthly",
        amountThb: 899,
        lastEventId: "bundle-grant:in_bundle_grant",
        eventOccurredAt: now,
      },
    });
    const userId2 = await paidUser({
      stripeSubscriptionId: "sub_bundle_on_user",
      bundleSubscriptionId: "sub_bundle_on_user",
      sessionId: "cs_a5_user_marker",
    });
    const stub = makeStub(
      {
        sub_bundle_entitlement: { status: "past_due", customer: "cus_bundle" },
        sub_bundle_on_user: { status: "past_due", customer: "cus_bundle" },
      },
      [{ id: "in_bundle_open", subscription: "sub_bundle_entitlement", status: "open" }],
    );
    const r1 = await cancelSupersededSubscription(stub.api, promptpaySession("cs_a5_entitlement", userId), { env: FLAG_ON, notify: async () => {} });
    const r2 = await cancelSupersededSubscription(stub.api, promptpaySession("cs_a5_user_marker", userId2), { env: FLAG_ON, notify: async () => {} });
    check("A5 a sub id recorded as a Bundle subscription (BundleEntitlement.subscriptionId) → zero Stripe calls",
      r1.outcome === "skipped" && r1.reason === "bundle_subscription", JSON.stringify(r1));
    check("A5 a sub id recorded as the user's Bundle subscription (User.bundleSubscriptionId) → zero Stripe calls",
      r2.outcome === "skipped" && r2.reason === "bundle_subscription", JSON.stringify(r2));
    check("A5 Bundle subscriptions and invoices untouched",
      stub.calls.length === 0 && stub.subs.sub_bundle_entitlement.status === "past_due"
        && stub.invoices[0].status === "open", JSON.stringify(stub.calls));
  }

  // A6 · a different subscription id than the user's stripeSubscriptionId → untouched
  {
    const userId = await paidUser({ stripeSubscriptionId: "sub_a6_mine", sessionId: "cs_a6", subStatus: "active" });
    const stub = makeStub(
      {
        sub_a6_mine: { status: "active", customer: "cus_a6" },
        sub_a6_other: { status: "past_due", customer: "cus_a6" },
      },
      [{ id: "in_a6_other_open", subscription: "sub_a6_other", status: "open" }],
    );
    await cancelSupersededSubscription(stub.api, promptpaySession("cs_a6", userId), { env: FLAG_ON, notify: async () => {} });
    check("A6 only the user's own sub id is ever read; a past_due sibling sub of the same customer is untouched",
      isDeepStrictEqual(stub.calls, [{ op: "retrieve", id: "sub_a6_mine" }])
        && stub.subs.sub_a6_other.status === "past_due" && stub.invoices[0].status === "open",
      JSON.stringify(stub.calls));

    const userNoSub = await paidUser({ stripeSubscriptionId: null, sessionId: "cs_a6_nosub", subStatus: null });
    stub.reset();
    const r = await cancelSupersededSubscription(stub.api, promptpaySession("cs_a6_nosub", userNoSub), { env: FLAG_ON, notify: async () => {} });
    check("A6 a user with no stripeSubscriptionId → zero Stripe calls (never searches the customer's subs)",
      stub.calls.length === 0 && r.outcome === "skipped" && r.reason === "no_subscription", JSON.stringify(r));
  }

  // A7 · rule (a): unpaid async session, credit pack, subscription-mode, ฿0 coupon, missing metadata → untouched
  {
    const userId = await paidUser({ stripeSubscriptionId: "sub_a7", sessionId: "cs_a7" });
    const stub = makeStub({ sub_a7: { status: "past_due", customer: "cus_a7" } },
      [{ id: "in_a7_open", subscription: "sub_a7", status: "open" }]);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unpaid checkout.session.completed (PromptPay not yet scanned)", promptpaySession("cs_a7", userId, { payment_status: "unpaid" })],
      ["credit pack (metadata.type credits)", promptpaySession("cs_a7", userId, {
        metadata: { type: "credits", userId, credits: "100" },
      })],
      ["credit pack that also carries plan metadata", promptpaySession("cs_a7", userId, {
        metadata: { type: "credits", userId, plan: "PRO", credits: "100" },
      })],
      ["subscription-mode (card) session", promptpaySession("cs_a7", userId, { mode: "subscription" })],
      ["no_payment_required ฿0 one-time session", promptpaySession("cs_a7", userId, { payment_status: "no_payment_required", amount_total: 0 })],
      ["session with no plan metadata", promptpaySession("cs_a7", userId, { metadata: { userId } })],
      ["session with an unknown plan", promptpaySession("cs_a7", userId, { metadata: { userId, plan: "FREE" } })],
    ];
    for (const [label, session] of cases) {
      stub.reset();
      const r = await cancelSupersededSubscription(stub.api, session as never, { env: FLAG_ON, notify: async () => {} });
      check(`A7 ${label} → zero Stripe calls`, stub.calls.length === 0 && r.outcome === "skipped", JSON.stringify(r));
    }
    // Belt: the helper only acts once our own DB has the PAID plan payment for this session.
    const pendingUser = await paidUser({ stripeSubscriptionId: "sub_a7", sessionId: "cs_a7_pending", paymentStatus: "PENDING" });
    stub.reset();
    const pending = await cancelSupersededSubscription(stub.api, promptpaySession("cs_a7_pending", pendingUser), { env: FLAG_ON, notify: async () => {} });
    const otherOwner = await paidUser({ stripeSubscriptionId: "sub_a7", sessionId: "cs_a7_owner" });
    const wrongOwner = await cancelSupersededSubscription(stub.api, promptpaySession("cs_a7_owner", userId), { env: FLAG_ON, notify: async () => {} });
    check("A7 Payment row not PAID yet, or owned by another user → zero Stripe calls",
      stub.calls.length === 0 && pending.outcome === "skipped" && wrongOwner.outcome === "skipped" && !!otherOwner,
      JSON.stringify({ pending, wrongOwner }));
    check("A7 nothing was canceled or voided", stub.subs.sub_a7.status === "past_due" && stub.invoices[0].status === "open");
  }

  // A9 · Stripe failure → no throw, admin alert with the required text; nothing rolled back
  for (const failOn of ["retrieve", "cancel", "list", "void"] as const) {
    const subId = `sub_a9_${failOn}`;
    const sessionId = `cs_a9_${failOn}`;
    const userId = await paidUser({ stripeSubscriptionId: subId, sessionId });
    const stub = makeStub({ [subId]: { status: "past_due", customer: "cus_a9" } },
      [{ id: `in_a9_${failOn}`, subscription: subId, status: "open" }]);
    stub.setFailOn(failOn);
    const n = recordingNotify();
    let threw: unknown = null;
    let result: Awaited<ReturnType<typeof cancelSupersededSubscription>> | null = null;
    try {
      result = await cancelSupersededSubscription(stub.api, promptpaySession(sessionId, userId), { env: FLAG_ON, notify: n.notify });
    } catch (e) { threw = e; }
    const alert = n.sent[0];
    check(`A9 ${failOn} fails → helper does not throw and reports failed`,
      threw === null && result?.outcome === "failed", String(threw ?? JSON.stringify(result)));
    check(`A9 ${failOn} fails → exactly one ERROR_SYSTEM admin alert`,
      n.sent.length === 1 && alert.type === "ERROR_SYSTEM", JSON.stringify(n.sent));
    check(`A9 ${failOn} fails → alert text has ERROR, the user id, the sub id and the required Thai sentence verbatim`,
      !!alert && /ERROR/.test(`${alert.title} ${alert.body}`) && alert.body.includes(userId)
        && alert.body.includes(subId) && alert.body.includes(REQUIRED_ALERT), JSON.stringify(alert));
    const payment = await prisma.payment.findUnique({ where: { stripeSessionId: sessionId } });
    const user = await prisma.user.findUnique({ where: { id: userId } });
    check(`A9 ${failOn} fails → payment stays PAID and the term stays`,
      payment?.status === "PAID" && user?.plan === "PRO" && !!user?.planExpiresAt && user.planExpiresAt > now);
    check(`A9 ${failOn} fails → never falls back to mark-uncollectible`, !stub.ops().includes("markUncollectible"));
  }
  {
    // the alert itself failing still never throws
    const userId = await paidUser({ stripeSubscriptionId: "sub_a9_notify", sessionId: "cs_a9_notify" });
    const stub = makeStub({ sub_a9_notify: { status: "past_due", customer: "cus_a9" } }, []);
    stub.setFailOn("cancel");
    let threw: unknown = null;
    try {
      await cancelSupersededSubscription(stub.api, promptpaySession("cs_a9_notify", userId), {
        env: FLAG_ON,
        notify: async () => { throw new Error("notification table locked"); },
      });
    } catch (e) { threw = e; }
    check("A9 a failing admin alert still never throws", threw === null, String(threw));
  }

  // A10 · flag off → never calls Stripe (every stub method would throw), never alerts
  {
    const userId = await paidUser({ stripeSubscriptionId: "sub_a10", sessionId: "cs_a10" });
    const tripwire = new Proxy({}, {
      get() { throw new Error("flag off: Stripe client must not even be touched"); },
    });
    const n = recordingNotify();
    let threw: unknown = null;
    let r: Awaited<ReturnType<typeof cancelSupersededSubscription>> | null = null;
    try {
      r = await cancelSupersededSubscription(tripwire as never, promptpaySession("cs_a10", userId), { env: FLAG_OFF, notify: n.notify });
    } catch (e) { threw = e; }
    check("A10 flag off → Stripe client never touched, skipped, no alert",
      threw === null && r?.outcome === "skipped" && r.reason === "flag_off" && n.sent.length === 0,
      String(threw ?? JSON.stringify(r)));
    const r2 = await cancelSupersededSubscription(tripwire as never, promptpaySession("cs_a10", userId), { env: { PROMPTPAY_MONTHLY: "true" }, notify: n.notify });
    check("A10 only PROMPTPAY_MONTHLY=1 turns it on (\"true\" stays off)", r2.outcome === "skipped" && r2.reason === "flag_off");
  }

  // ═══ B · the real webhook route ═══════════════════════════════════════════
  console.log("\nB. the real webhook POST handler, signed events, Stripe methods stubbed");
  const { stripe } = await import("../src/lib/stripe");
  // Network belt: the cached client (the same instance the route's proxy uses)
  // gets an HTTP layer that refuses every request and a local dead host. Any
  // Stripe call this test did not stub fails locally and is counted.
  let networkAttempts = 0;
  const blockedHttp = {
    getClientName: () => "blocked-in-test",
    makeRequest: () => {
      networkAttempts += 1;
      return Promise.reject(new Error("BLOCKED: a real Stripe HTTP request was attempted in a test"));
    },
  };
  const stripeInternals = stripe as unknown as { _setApiField(key: string, value: unknown): void };
  stripeInternals._setApiField("httpClient", blockedHttp);
  stripeInternals._setApiField("host", "127.0.0.1");
  stripeInternals._setApiField("port", 9);
  stripeInternals._setApiField("maxNetworkRetries", 0);

  const routeStub = makeStub({}, []);
  Object.assign(stripe.subscriptions, {
    retrieve: routeStub.api.subscriptions.retrieve,
    cancel: routeStub.api.subscriptions.cancel,
  });
  Object.assign(stripe.invoices, {
    list: routeStub.api.invoices.list,
    voidInvoice: routeStub.api.invoices.voidInvoice,
    markUncollectible: routeStub.api.invoices.markUncollectible,
  });

  const signer = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-04-22.dahlia" });
  const { POST } = await import("../src/app/api/payments/webhook/route");
  let eventSeq = 0;
  async function postEvent(type: string, object: Record<string, unknown>) {
    eventSeq += 1;
    const body = JSON.stringify({
      id: `evt_cancel_superseded_${eventSeq}`,
      object: "event",
      api_version: "2026-04-22.dahlia",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type,
      data: { object },
    });
    const signature = signer.webhooks.generateTestHeaderString({ payload: body, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    const res = await POST(new Request("http://localhost/api/payments/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature, "content-type": "application/json" },
      body,
    }));
    return { res, eventId: `evt_cancel_superseded_${eventSeq}` };
  }

  await prisma.user.create({
    data: { id: "admin-1", name: "Admin", email: "admin@example.com", role: "ADMIN" },
  });

  async function routeUser(id: string, subId: string, sessionId: string, payment: "PENDING" | "PAID", planExpiresAt: Date | null) {
    await prisma.user.create({
      data: {
        id,
        name: id,
        email: `${id}@example.com`,
        plan: payment === "PAID" ? "PRO" : "FREE",
        planExpiresAt,
        stripeCustomerId: `cus_${id}`,
        stripeSubscriptionId: subId,
        subStatus: "past_due",
        billingPeriod: "monthly",
      },
    });
    await prisma.payment.create({
      data: {
        userId: id,
        stripeSessionId: sessionId,
        plan: "PRO",
        amount: 59900,
        status: payment,
        periodDays: 30,
        paidAt: payment === "PAID" ? new Date() : null,
      },
    });
  }

  process.env.PROMPTPAY_MONTHLY = "1";

  // B1 · settled path: unpaid completed → nothing; async_payment_succeeded → activate + cancel + void
  {
    await routeUser("route-user-1", "sub_route_1", "cs_route_1", "PENDING", null);
    routeStub.subs.sub_route_1 = { status: "past_due", customer: "cus_route-user-1" };
    routeStub.invoices.push({ id: "in_route_1_open", subscription: "sub_route_1", status: "open" });
    routeStub.reset();
    const unpaid = await postEvent("checkout.session.completed", promptpaySession("cs_route_1", "route-user-1", { payment_status: "unpaid", payment_intent: null }));
    const afterUnpaid = await prisma.user.findUnique({ where: { id: "route-user-1" } });
    check("B1 unpaid checkout.session.completed → 200, no activation, zero Stripe calls",
      unpaid.res.status === 200 && afterUnpaid?.plan === "FREE" && routeStub.calls.length === 0, JSON.stringify(routeStub.calls));

    const before = Date.now();
    const paid = await postEvent("checkout.session.async_payment_succeeded", promptpaySession("cs_route_1", "route-user-1", { payment_intent: "pi_route_1" }));
    const user = await prisma.user.findUnique({ where: { id: "route-user-1" } });
    const payment = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_route_1" } });
    check("B1 async_payment_succeeded → 200, Payment PAID, PRO for 30 days",
      paid.res.status === 200 && payment?.status === "PAID" && user?.plan === "PRO"
        && !!user?.planExpiresAt && Math.abs(user.planExpiresAt.getTime() - (before + 30 * DAY_MS)) < 60_000,
      JSON.stringify({ status: paid.res.status, payment, plan: user?.plan, exp: user?.planExpiresAt }));
    check("B1 the past_due subscription is canceled (no proration, no final invoice) and its open invoice voided",
      isDeepStrictEqual(routeStub.ops(), ["retrieve", "cancel", "list", "void"])
        && isDeepStrictEqual(routeStub.calls[1].params, { invoice_now: false, prorate: false })
        && routeStub.subs.sub_route_1.status === "canceled"
        && routeStub.invoices.find((i) => i.id === "in_route_1_open")?.status === "void",
      JSON.stringify(routeStub.calls));

    // B6 · the customer.subscription.deleted Stripe sends after our cancel clears sub fields only
    const expiryBefore = user?.planExpiresAt?.getTime();
    routeStub.reset();
    const deleted = await postEvent("customer.subscription.deleted", {
      id: "sub_route_1", object: "subscription", customer: "cus_route-user-1", status: "canceled",
    });
    const afterDeleted = await prisma.user.findUnique({ where: { id: "route-user-1" } });
    check("B6 customer.subscription.deleted after our cancel keeps plan + planExpiresAt, clears only sub fields",
      deleted.res.status === 200 && afterDeleted?.plan === "PRO"
        && afterDeleted?.planExpiresAt?.getTime() === expiryBefore
        && afterDeleted?.stripeSubscriptionId === null && afterDeleted?.subStatus === "canceled"
        && routeStub.calls.length === 0,
      JSON.stringify(afterDeleted));
  }

  // B2 · the already_paid retry path: activation already committed, the Stripe call never happened
  {
    const expiry = new Date(Date.now() + 30 * DAY_MS);
    await routeUser("route-user-2", "sub_route_2", "cs_route_2", "PAID", expiry);
    routeStub.subs.sub_route_2 = { status: "past_due", customer: "cus_route-user-2" };
    routeStub.invoices.push({ id: "in_route_2_open", subscription: "sub_route_2", status: "open" });
    routeStub.reset();
    const retry = await postEvent("checkout.session.async_payment_succeeded", promptpaySession("cs_route_2", "route-user-2", { payment_intent: "pi_route_2" }));
    const user = await prisma.user.findUnique({ where: { id: "route-user-2" } });
    check("B2 already_paid retry → 200 and the term is NOT extended a second time",
      retry.res.status === 200 && user?.planExpiresAt?.getTime() === expiry.getTime(),
      JSON.stringify({ status: retry.res.status, exp: user?.planExpiresAt, expected: expiry }));
    check("B2 already_paid retry path triggers the helper: subscription canceled, open invoice voided",
      isDeepStrictEqual(routeStub.ops(), ["retrieve", "cancel", "list", "void"])
        && routeStub.subs.sub_route_2.status === "canceled"
        && routeStub.invoices.find((i) => i.id === "in_route_2_open")?.status === "void",
      JSON.stringify(routeStub.calls));

    // B2b · a second retry of the same session after success is a no-op
    routeStub.reset();
    const retry2 = await postEvent("checkout.session.async_payment_succeeded", promptpaySession("cs_route_2", "route-user-2", { payment_intent: "pi_route_2" }));
    check("B2b retry after success → 200, status read only",
      retry2.res.status === 200 && isDeepStrictEqual(routeStub.ops(), ["retrieve"]), JSON.stringify(routeStub.calls));
  }

  // B3 · Stripe failure through the route: 200, payment kept, admin alerted, claim kept (no retry storm)
  {
    await routeUser("route-user-3", "sub_route_3", "cs_route_3", "PENDING", null);
    routeStub.subs.sub_route_3 = { status: "past_due", customer: "cus_route-user-3" };
    routeStub.invoices.push({ id: "in_route_3_open", subscription: "sub_route_3", status: "open" });
    routeStub.reset();
    routeStub.setFailOn("cancel");
    const res = await postEvent("checkout.session.async_payment_succeeded", promptpaySession("cs_route_3", "route-user-3", { payment_intent: "pi_route_3" }));
    routeStub.setFailOn(null);
    const payment = await prisma.payment.findUnique({ where: { stripeSessionId: "cs_route_3" } });
    const user = await prisma.user.findUnique({ where: { id: "route-user-3" } });
    const claim = await prisma.stripeWebhookEvent.findUnique({ where: { id: res.eventId } });
    const alerts = await prisma.notification.findMany({ where: { userId: "admin-1", type: "ERROR_SYSTEM" } });
    const alert = alerts.find((a) => a.body.includes("sub_route_3"));
    check("B3 Stripe cancel fails → webhook still 200 (does not throw)", res.res.status === 200, String(res.res.status));
    check("B3 Stripe cancel fails → Payment PAID and the PRO term stay recorded",
      payment?.status === "PAID" && user?.plan === "PRO" && !!user?.planExpiresAt && user.planExpiresAt.getTime() > Date.now());
    check("B3 Stripe cancel fails → the event claim is kept (a Stripe failure is not a webhook failure)", !!claim);
    check("B3 Stripe cancel fails → an ADMIN gets an ERROR_SYSTEM notification with ERROR, user id, sub id and the required text",
      !!alert && /ERROR/.test(`${alert.title} ${alert.body}`) && alert.body.includes("route-user-3")
        && alert.body.includes("sub_route_3") && alert.body.includes(REQUIRED_ALERT),
      JSON.stringify(alerts));
    check("B3 the invoice stays open (nothing half-voided silently)",
      routeStub.invoices.find((i) => i.id === "in_route_3_open")?.status === "open");
  }

  // B4 · credit pack through the route (CREDITS_LIVE on) → zero Stripe calls
  {
    await prisma.user.create({
      data: {
        id: "route-user-4", name: "route-user-4", email: "route-user-4@example.com", plan: "PRO",
        planExpiresAt: new Date(Date.now() + 10 * DAY_MS), stripeSubscriptionId: "sub_route_4", subStatus: "past_due",
      },
    });
    routeStub.subs.sub_route_4 = { status: "past_due", customer: "cus_route-user-4" };
    routeStub.reset();
    process.env.CREDITS_LIVE = "1";
    const res = await postEvent("checkout.session.completed", {
      id: "cs_route_4_credits", object: "checkout.session", mode: "payment", payment_status: "paid",
      amount_total: 19900, currency: "thb", payment_intent: "pi_route_4",
      metadata: { type: "credits", userId: "route-user-4", credits: "100" },
    });
    process.env.CREDITS_LIVE = "0";
    check("B4 a paid credit pack → 200 and zero Stripe calls; the past_due sub is untouched",
      res.res.status === 200 && routeStub.calls.length === 0 && routeStub.subs.sub_route_4.status === "past_due",
      JSON.stringify(routeStub.calls));
  }

  // B5 · flag off through the route → activation as today, zero Stripe calls
  {
    delete process.env.PROMPTPAY_MONTHLY;
    await routeUser("route-user-5", "sub_route_5", "cs_route_5", "PENDING", null);
    routeStub.subs.sub_route_5 = { status: "past_due", customer: "cus_route-user-5" };
    routeStub.reset();
    const res = await postEvent("checkout.session.async_payment_succeeded", promptpaySession("cs_route_5", "route-user-5", { payment_intent: "pi_route_5" }));
    const user = await prisma.user.findUnique({ where: { id: "route-user-5" } });
    check("B5 flag off → activation unchanged, zero Stripe calls, sub still past_due",
      res.res.status === 200 && user?.plan === "PRO" && routeStub.calls.length === 0
        && routeStub.subs.sub_route_5.status === "past_due", JSON.stringify(routeStub.calls));
    process.env.PROMPTPAY_MONTHLY = "1";
  }

  check("B network belt: no real Stripe HTTP request was ever attempted", networkAttempts === 0, String(networkAttempts));

  // ═══ C · source text ══════════════════════════════════════════════════════
  console.log("\nC. source-text checks");
  const route = src("src/app/api/payments/webhook/route.ts");
  const lib = src("src/lib/cancel-superseded-subscription.ts");

  // C1 · customer.subscription.deleted only clears subscription fields
  const deletedStart = route.indexOf('if (event.type === "customer.subscription.deleted")');
  const deletedEnd = route.indexOf("if (event.type ===", deletedStart + 10);
  const deletedBlock = deletedStart >= 0 && deletedEnd > deletedStart ? route.slice(deletedStart, deletedEnd) : "";
  const deletedData = /prisma\.user\.update\(\{[\s\S]*?data:\s*\{([^}]*)\}/.exec(deletedBlock)?.[1] ?? "";
  const deletedKeys = deletedData.split(",").map((part) => part.split(":")[0].trim()).filter(Boolean).sort();
  check("C1 customer.subscription.deleted writes exactly subStatus, stripeSubscriptionId, cancelAtPeriodEnd, cancelAt",
    isDeepStrictEqual(deletedKeys, ["cancelAt", "cancelAtPeriodEnd", "stripeSubscriptionId", "subStatus"]), JSON.stringify(deletedKeys));
  check("C1 customer.subscription.deleted never touches plan / planExpiresAt",
    deletedBlock.length > 0 && !/\bplan\b|planExpiresAt|billingPeriod/.test(deletedBlock.replace(/\/\/.*$/gm, "")));
  check("C1 customer.subscription.deleted has a single DB write", (deletedBlock.match(/prisma\.\w+\.(update|updateMany|upsert|create|delete)\(/g) ?? []).length === 1);

  // C2–C5 · wiring on both paths
  check("C2 route imports cancelSupersededSubscription from the lib",
    /import \{ cancelSupersededSubscription \} from "@\/lib\/cancel-superseded-subscription";/.test(route));
  const handler = route.slice(route.indexOf("async function handleCheckoutSession"), route.indexOf("export async function POST"));
  const alreadyPaidBlock = /if \(!activation\.activated\) \{([\s\S]*?)\n {2}\}/.exec(handler)?.[1] ?? "";
  check("C3 the already_paid early return calls the helper with the Stripe client before returning",
    /await cancelSupersededSubscription\(stripe, s\);[\s\S]*return;/.test(alreadyPaidBlock), alreadyPaidBlock);
  const successTail = handler.slice(handler.indexOf("const { newExpiry } = activation;"));
  check("C4 the settled success path calls the helper right after activation",
    handler.includes("const { newExpiry } = activation;")
      && /^const \{ newExpiry \} = activation;\s*(\/\/[^\n]*\n\s*)*await cancelSupersededSubscription\(stripe, s\);/.test(successTail),
    successTail.slice(0, 300));
  const creditReturn = handler.indexOf('if (s.metadata?.type === "credits"');
  const settledGate = handler.indexOf("if (!checkoutPaymentSettled(s))");
  const firstCall = handler.indexOf("cancelSupersededSubscription(");
  check("C5 the helper is only reached after the credit-pack branch and the settled gate",
    creditReturn >= 0 && settledGate > creditReturn && firstCall > settledGate);
  check("C5 the helper is called exactly twice in the route",
    (route.match(/await cancelSupersededSubscription\(stripe, s\)/g) ?? []).length === 2);
  check("C5 the route never cancels/voids by itself (logic lives in the lib)",
    !/subscriptions\.cancel\(|voidInvoice\(|markUncollectible\(/.test(route));

  // C6–C7 · lib
  check("C6 the lib reads the flag only through promptpayMonthlyEnabled",
    /promptpayMonthlyEnabled\(/.test(lib) && !/process\.env\.PROMPTPAY_MONTHLY|\["PROMPTPAY_MONTHLY"\]/.test(lib));
  check("C7 the lib never marks an invoice uncollectible", !/markUncollectible\(/.test(lib));
  check("C7 the lib carries the required alert sentence verbatim", lib.includes(REQUIRED_ALERT));
  check("C7 the lib cancels with invoice_now:false + prorate:false",
    /invoice_now:\s*false/.test(lib) && /prorate:\s*false/.test(lib));

  // C8 · CI wiring through the existing npm chain
  const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> };
  check("C8 verify:promptpay-monthly chains this script",
    (pkg.scripts["verify:promptpay-monthly"] ?? "").includes("scripts/verify-cancel-superseded-subscription.ts"));

  await new Promise((resolve) => setTimeout(resolve, 50));
  await prisma.$disconnect();

  if (failures > 0) {
    console.error(`\nverify-cancel-superseded-subscription: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nverify-cancel-superseded-subscription: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
