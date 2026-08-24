import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADMIN_ERROR_NOTIFY_WINDOW_MS,
  decideAdminErrorNotify,
  isCapacityError,
  type AdminErrorNotifyStore,
} from "../src/lib/admin-error-notify";

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}`);
  }
}

const socketTimeout = new Error(
  "Socket timeout (the database failed to respond to a query within the configured timeout).",
);
const p1008 = Object.assign(new Error("Timed out fetching a new connection from the connection pool."), {
  code: "P1008",
});
const p2028 = Object.assign(new Error("Unable to start a transaction in the given time."), { code: "P2028" });
const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
const heygenTimeout = new Error("HeyGen timed out waiting for avatar video");
const eleven401 = new Error("ElevenLabs 401 subscription_required");

check("socket timeout is capacity", isCapacityError(socketTimeout));
check("P1008 is capacity", isCapacityError(p1008));
check("P2028 is capacity", isCapacityError(p2028));
check("SQLITE_BUSY is capacity", isCapacityError(busy));
check("HeyGen timeout is not SQLite capacity", !isCapacityError(heygenTimeout));
check("ElevenLabs 401 is not capacity", !isCapacityError(eleven401));

const store: AdminErrorNotifyStore = new Map();
const t0 = 1_000_000;

const firstMe = decideAdminErrorNotify({ error: socketTimeout, route: "user/me", nowMs: t0, store });
check("user/me socket timeout never writes", firstMe.action === "skip_capacity");

const twenty: ReturnType<typeof decideAdminErrorNotify>[] = [];
for (let i = 0; i < 20; i += 1) {
  twenty.push(
    decideAdminErrorNotify({
      error: eleven401,
      route: "GET /api/elevenlabs/voices",
      nowMs: t0 + i * 1_000,
      store,
    }),
  );
}
check("first non-timeout write persists", twenty[0]?.action === "write" && twenty[0].suppressed === 0);
check(
  "next 19 in the same window are rate-limited",
  twenty.slice(1).every((d) => d.action === "skip_rate_limit"),
);
check(
  "20 identical non-timeout errors persist one",
  twenty.filter((d) => d.action === "write").length === 1,
);

const afterWindow = decideAdminErrorNotify({
  error: eleven401,
  route: "GET /api/elevenlabs/voices",
  nowMs: t0 + ADMIN_ERROR_NOTIFY_WINDOW_MS,
  store,
});
check("after 5 minutes the route may write again", afterWindow.action === "write");
check("next window reports suppressed count from the last window", afterWindow.action === "write" && afterWindow.suppressed === 19);

const otherRoute = decideAdminErrorNotify({
  error: eleven401,
  route: "GET /api/credits/balance",
  nowMs: t0 + 2_000,
  store,
});
check("a different route is not blocked by another route's window", otherRoute.action === "write");

const capacityDuringFlood = decideAdminErrorNotify({
  error: socketTimeout,
  route: "GET /api/credits/balance",
  nowMs: t0 + 3_000,
  store,
});
check("capacity skip does not consume the rate-limit slot", capacityDuringFlood.action === "skip_capacity");

const apiErrorSrc = readFileSync("src/lib/api-error.ts", "utf8");
check("apiError consults decideAdminErrorNotify", /decideAdminErrorNotify\(\{ error, route \}\)/.test(apiErrorSrc));
check(
  "notifyAdmins from apiError is gated on write",
  /if \(decision\.action === "write"\) \{[\s\S]*notifyAdmins\(/.test(apiErrorSrc),
);
check(
  "pipeline notifyUser still runs after the admin gate",
  /if \(notifyUser && uid\) \{[\s\S]*createNotification\(/.test(apiErrorSrc)
    && apiErrorSrc.indexOf("if (decision.action === \"write\")") < apiErrorSrc.indexOf("if (notifyUser && uid)"),
);

function callsNotifyAdminsDirectly(path: string): boolean {
  const src = readFileSync(path, "utf8");
  return /notifyAdmins\(/.test(src) && !/decideAdminErrorNotify/.test(src);
}
check("support tickets still write immediately", callsNotifyAdminsDirectly("src/app/api/support/route.ts"));
check("Stripe webhook still writes immediately", callsNotifyAdminsDirectly("src/app/api/payments/webhook/route.ts"));
check("disk-watch still writes immediately", callsNotifyAdminsDirectly("src/app/api/cron/disk-watch/route.ts"));

assert.equal(failures, 0, `${failures} check(s) FAILED`);
console.log("\nverify-admin-error-notify: PASS");
