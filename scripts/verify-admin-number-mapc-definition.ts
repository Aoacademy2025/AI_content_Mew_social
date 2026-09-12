// Task C10 (audit A4 §8) — the MAPC numerator must mean what CONTEXT.md says it means.
//
// The shipped MAPC is arithmetically exact; A4's finding was that two numerator details did not
// match the Core Creation Outcome definition:
//
//   A2 — Hero Script. CONTEXT.md: "one **saved or Editor-bound** Hero Script". The query counted
//        every `Script` row created in the window, including the 25 still at the model default
//        `status = "draft"` on prod. A draft is work in progress, not a delivered outcome. Only
//        the send-to-editor path writes `{ status: "sent", editorProjectId: project.id }`
//        (`src/lib/hero-script.server.ts:1442`); `PUT /api/scripts/[id]` deliberately cannot patch
//        either field. So the outcome predicate is `status = "sent" OR editorProjectId IS NOT NULL`
//        — the OR arm keeps any legacy row that reached the editor before the pair was written
//        together.
//
//   A3 — Video. The window test was `updatedAt >= since`, so ANY later touch of an old row (a
//        thumbnail edit, `video-reconcile`) dragged a months-old video into the trailing 30 days.
//        `Video` carries no completion timestamp (`createdAt`/`updatedAt`/`expiresAt` only), and
//        the live delivery path — `POST /api/videos` → `persistExportGalleryVideo` — INSERTs the
//        row already COMPLETED and already carrying its output URL, so `createdAt` IS the delivery
//        instant (A4 §7: all 1,585 prod rows are COMPLETED with an output URL). The window test is
//        therefore `createdAt >= since`.
//
// The denominator does NOT move. That is the point of the golden phase below.
//
// Shape of the proof — one fixture DB, two passes over the SAME users:
//   Phase 1 (GOLDEN) seeds the whole denominator and gives it only outcomes that are unambiguous
//     under both the old and the new rule. Its three headline numbers are recorded here as literals
//     taken from the CURRENT code, so they must come out identical after the change — that is what
//     proves the denominator and the untouched numerator cases did not move.
//   Phase 2 (RULES) adds ONLY the ambiguous rows — a draft script, an Editor-bound script, and an
//     old video touched today — to users that were already in the denominator. So
//     activePayingCustomers / activeRecurringPayers MUST still equal the phase-1 goldens, and every
//     change is attributable to the two numerator rules.
//
// Run: node --conditions=react-server --import tsx scripts/verify-admin-number-mapc-definition.ts
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "admin-number-mapc-definition-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`ok: ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const DAY = 86_400_000;
const NOW = new Date("2026-09-12T04:00:00.000Z");
const SINCE = new Date(NOW.getTime() - 30 * DAY); // the MAPC window opens here
const IN_WINDOW = new Date(NOW.getTime() - 5 * DAY);
const BEFORE_WINDOW = new Date(NOW.getTime() - 100 * DAY);
const FUTURE = new Date(NOW.getTime() + 200 * DAY);

// ---- Goldens: read off the CURRENT code on the phase-1 fixture, before either rule changed. ----
// They describe the denominator and the outcome cases neither rule touches, so every one of them
// must survive the change byte-for-byte.
const GOLDEN = {
  activePayingCustomers: 6, // 5 recurring + 1 prepaid annual term still running (option A)
  activeRecurringPayers: 5, // the prepaid payer has no live Stripe subscription
  activeCreators: 3, // fresh video · sent script · settled image
  monthlyCreators: 2,
  annualCreators: 1,
  videoCreators: 1,
  scriptCreators: 1,
  imageCreators: 1,
  creatorRatePct: 50,
} as const;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getSubscriptionNorthStar, writeSubscriptionNorthStarSnapshot } =
    await import("../src/lib/subscription-north-star.server");

  // ---- denominator ------------------------------------------------------------------------
  // Every payer below is seeded in phase 1 and never edited again, so the denominator is frozen
  // across both phases by construction.
  const recurring = (id: string) => ({
    id, name: id, email: `${id}@example.test`, plan: "PRO",
    stripeSubscriptionId: `sub_${id}`, subStatus: "active",
    billingPeriod: "monthly", planExpiresAt: FUTURE,
  });
  await prisma.user.createMany({
    data: [
      recurring("recurring-video"), // outcome = a video delivered inside the window
      recurring("recurring-image"), // outcome = a settled Hero AI Image
      recurring("draft-only"), // phase 2 gives it a DRAFT script and nothing else
      recurring("editor-bound"), // phase 2 gives it an Editor-bound script
      recurring("old-video-touched"), // phase 2 gives it a 100-day-old video touched today
      // Option A: a customer who paid for an annual term up front is still a paying customer for
      // the life of that term, even though Stripe will not auto-bill them. In the denominator,
      // out of activeRecurringPayers.
      {
        id: "prepaid-term", name: "prepaid-term", email: "prepaid-term@example.test", plan: "PRO",
        billingPeriod: "annual", planExpiresAt: FUTURE,
      },
      // Guard: entitled and active, but no cash ever. Must stay out of the denominator, which also
      // keeps its outcomes out of the numerator — proof the numerator is gated by the denominator.
      {
        id: "no-cash", name: "no-cash", email: "no-cash@example.test", plan: "PRO",
        stripeSubscriptionId: "sub_no_cash", subStatus: "active",
        billingPeriod: "monthly", planExpiresAt: FUTURE,
      },
    ],
  });
  await prisma.payment.createMany({
    data: [
      "recurring-video", "recurring-image", "draft-only", "editor-bound", "old-video-touched",
    ].map((userId) => ({
      id: `pay-${userId}`, userId, stripeSessionId: `cs_${userId}`, plan: "PRO",
      amount: 59_900, status: "PAID", periodDays: 30, paidAt: IN_WINDOW, createdAt: IN_WINDOW,
    })).concat([{
      id: "pay-prepaid-term", userId: "prepaid-term", stripeSessionId: "cs_prepaid-term", plan: "PRO",
      amount: 299_500, status: "PAID", periodDays: 365, paidAt: IN_WINDOW, createdAt: IN_WINDOW,
    }]),
  });

  const video = (id: string, userId: string, createdAt: Date) => prisma.video.create({
    data: {
      id, userId, avatarModel: "none", voiceModel: "gemini", sceneCount: 1,
      status: "COMPLETED", videoUrl: `/outputs/${id}.mp4`, createdAt,
    },
  });
  const script = (
    id: string, userId: string,
    extra: { status?: string; editorProjectId?: string } = {},
  ) => prisma.script.create({
    data: {
      id, userId, topic: "topic", hookText: "hook", bodyText: "body", ctaText: "cta",
      createdAt: IN_WINDOW, ...extra,
    },
  });

  // ---- phase 1: only unambiguous outcomes ---------------------------------------------------
  await video("v-fresh", "recurring-video", IN_WINDOW);
  await script("s-sent", "prepaid-term", { status: "sent", editorProjectId: "proj-prepaid" });
  await prisma.aiGenerationJob.create({
    data: {
      userId: "recurring-image", kind: "image", provider: "runpod", model: "z-image-turbo",
      status: "completed", outputUrl: "/outputs/image.png", chargeState: "settled",
      productSurface: "hero_video", finishedAt: IN_WINDOW,
    },
  });
  // The no-cash account produces both kinds of outcome; neither may ever surface.
  await video("v-no-cash", "no-cash", IN_WINDOW);
  await script("s-no-cash", "no-cash", { status: "sent" });

  const golden = await getSubscriptionNorthStar(NOW);
  for (const [key, want] of Object.entries(GOLDEN)) {
    const got = key === "videoCreators" || key === "scriptCreators" || key === "imageCreators"
      ? golden.outcomes[key as "videoCreators" | "scriptCreators" | "imageCreators"]
      : (golden as unknown as Record<string, number>)[key];
    check(got === want, `golden (clean fixture): ${key}`, `got ${got}, golden ${want}`);
  }

  // ---- phase 2: add the rows the two rules are about ----------------------------------------
  // A2 fixture 1 — a draft. The model default is "draft" and no send-to-editor happened.
  await script("s-draft", "draft-only");
  // A2 fixture 2 — Editor-bound but still labelled "draft": the OR arm. A predicate written as
  // `status = 'sent'` alone would silently drop this creator.
  await script("s-editor-bound", "editor-bound", { editorProjectId: "proj-editor-bound" });
  // A3 fixture — delivered 100 days ago, touched today. The touch is a real Prisma update, which
  // is how `@updatedAt` gets bumped in production (thumbnail edit, video-reconcile).
  await video("v-old", "old-video-touched", BEFORE_WINDOW);
  await prisma.video.update({ where: { id: "v-old" }, data: { thumbnail: "/thumbs/v-old.jpg" } });

  const seeded = await prisma.script.findMany({
    where: { id: { in: ["s-draft", "s-editor-bound", "s-sent"] } },
    select: { id: true, status: true, editorProjectId: true },
    orderBy: { id: "asc" },
  });
  check(
    seeded.some((row) => row.id === "s-draft" && row.status === "draft" && row.editorProjectId === null),
    "fixture: the draft script really is status=draft with no editorProjectId",
    JSON.stringify(seeded.find((row) => row.id === "s-draft")),
  );
  check(
    seeded.some((row) => row.id === "s-editor-bound" && row.status === "draft" && row.editorProjectId !== null),
    "fixture: the Editor-bound script is not status=sent, so only the OR arm can catch it",
    JSON.stringify(seeded.find((row) => row.id === "s-editor-bound")),
  );
  const old = await prisma.video.findUniqueOrThrow({
    where: { id: "v-old" },
    select: { createdAt: true, updatedAt: true, status: true, videoUrl: true },
  });
  check(
    old.createdAt < SINCE && old.updatedAt >= SINCE,
    "fixture: the old video is outside the window by createdAt and inside it by updatedAt",
    `createdAt=${old.createdAt.toISOString()} updatedAt=${old.updatedAt.toISOString()} since=${SINCE.toISOString()}`,
  );

  const metric = await getSubscriptionNorthStar(NOW);

  // ---- the denominator did not move ---------------------------------------------------------
  check(
    metric.activePayingCustomers === GOLDEN.activePayingCustomers,
    "denominator unchanged: activePayingCustomers still counts every active paid entitlement",
    `${metric.activePayingCustomers} (golden ${GOLDEN.activePayingCustomers})`,
  );
  check(
    metric.activeRecurringPayers === GOLDEN.activeRecurringPayers,
    "denominator unchanged: activeRecurringPayers is still the recurring-only figure",
    `${metric.activeRecurringPayers} (golden ${GOLDEN.activeRecurringPayers})`,
  );
  check(
    metric.activePayingCustomers - metric.activeRecurringPayers === 1,
    "option A: the prepaid annual term is in the paid denominator but not the recurring one",
  );

  // ---- A2: the Hero Script rule -------------------------------------------------------------
  check(
    metric.outcomes.scriptCreators === 2,
    "A2: a Hero Script outcome is a sent or Editor-bound script — the draft does not count",
    `scriptCreators=${metric.outcomes.scriptCreators} (expected 2: prepaid-term sent, editor-bound)`,
  );

  // ---- A3: the video rule -------------------------------------------------------------------
  check(
    metric.outcomes.videoCreators === 1,
    "A3: a video outcome is dated by completion — touching a 100-day-old row does not revive it",
    `videoCreators=${metric.outcomes.videoCreators} (expected 1: v-fresh)`,
  );

  // ---- the headline ------------------------------------------------------------------------
  check(
    metric.activeCreators === 4,
    "MAPC counts the four customers who actually delivered something in the window",
    `activeCreators=${metric.activeCreators} (expected 4: recurring-video, recurring-image, prepaid-term, editor-bound)`,
  );
  check(
    metric.activeCreators !== 6,
    "regression guard: the pre-fix numerator counted the draft and the touched-old video too",
  );
  check(metric.monthlyCreators === 3 && metric.annualCreators === 1,
    "the billing split follows the same four creators",
    `monthly=${metric.monthlyCreators} annual=${metric.annualCreators}`);
  check(metric.outcomes.imageCreators === GOLDEN.imageCreators,
    "the image outcome is untouched by either rule",
    `imageCreators=${metric.outcomes.imageCreators}`);
  check(metric.creatorRatePct === 67,
    "creator rate = 4/6 of the unchanged denominator",
    `creatorRatePct=${metric.creatorRatePct}`);

  // ---- one implementation, two callers ------------------------------------------------------
  // The nightly cron must not be able to drift from the live figure: it calls the same function.
  const snapshot = await writeSubscriptionNorthStarSnapshot(NOW);
  const row = await prisma.northStarDailySnapshot.findUniqueOrThrow({
    where: { snapshotDate: snapshot.snapshotDate },
  });
  check(
    row.activeCreators === metric.activeCreators
      && row.activePayingCustomers === metric.activePayingCustomers
      && row.activeRecurringPayers === metric.activeRecurringPayers
      && row.scriptCreators === metric.outcomes.scriptCreators
      && row.videoCreators === metric.outcomes.videoCreators
      && row.imageCreators === metric.outcomes.imageCreators,
    "the nightly snapshot cron records the same numerator rules as the live figure",
    `snapshot creators=${row.activeCreators}/${row.scriptCreators}/${row.videoCreators} live=${metric.activeCreators}/${metric.outcomes.scriptCreators}/${metric.outcomes.videoCreators}`,
  );

  await prisma.$disconnect();
}

main()
  .catch((error) => {
    failed += 1;
    console.error(error);
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} ok, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
