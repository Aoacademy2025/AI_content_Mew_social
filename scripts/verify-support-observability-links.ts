import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSupportObservabilityLinks,
  normalizeLinearIssueReference,
  normalizeSentryIssueReference,
  parseSupportObservabilityUpdate,
} from "../src/lib/support-observability-links";

const read = (path: string) => readFileSync(path, "utf8");

assert.equal(normalizeSentryIssueReference("7712316354"), "7712316354");
assert.equal(
  normalizeSentryIssueReference("https://mew-social-k0.sentry.io/issues/7712316354/?project=1"),
  "7712316354",
);
assert.equal(
  normalizeSentryIssueReference("https://sentry.io/organizations/mew-social-k0/issues/7712316354/events/"),
  "7712316354",
);
assert.equal(normalizeSentryIssueReference("0"), null, "zero is not a valid Sentry group ID");
assert.equal(
  normalizeSentryIssueReference("https://other-org.sentry.io/issues/7712316354/"),
  null,
  "a Sentry issue from another organization is rejected",
);
assert.equal(
  normalizeSentryIssueReference("http://mew-social-k0.sentry.io/issues/7712316354/"),
  null,
  "only HTTPS Sentry links are accepted",
);

assert.equal(normalizeLinearIssueReference("hero-6"), "HERO-6");
assert.equal(
  normalizeLinearIssueReference("https://linear.app/mew-social/issue/HERO-6/support-observability"),
  "HERO-6",
);
assert.equal(
  normalizeLinearIssueReference("https://linear.app/another-team/issue/HERO-6"),
  null,
  "a Linear issue outside Mew Social is rejected",
);
assert.equal(
  normalizeLinearIssueReference("https://linear.app/mew-social/project/HERO-6"),
  null,
  "only Linear issue URLs are accepted",
);

assert.deepEqual(parseSupportObservabilityUpdate({}), {
  ok: true,
  data: { sentryIssueId: undefined, linearIssueIdentifier: undefined },
});
assert.deepEqual(parseSupportObservabilityUpdate({ sentryIssueId: "  " }), {
  ok: true,
  data: { sentryIssueId: null, linearIssueIdentifier: undefined },
});
assert.deepEqual(
  parseSupportObservabilityUpdate({ linearIssueIdentifier: "https://linear.app/mew-social/issue/OPS-12" }),
  {
    ok: false,
    field: "linearIssueIdentifier",
    error: "linearIssueIdentifier must be a HERO issue identifier or URL",
  },
);

assert.deepEqual(
  buildSupportObservabilityLinks({
    sentryIssueId: "7712316354",
    linearIssueIdentifier: "hero-6",
  }),
  {
    sentryIssueUrl: "https://mew-social-k0.sentry.io/issues/7712316354/",
    linearIssueUrl: "https://linear.app/mew-social/issue/HERO-6",
  },
  "saved identifiers produce canonical links on trusted hosts",
);
assert.deepEqual(
  buildSupportObservabilityLinks({ sentryIssueId: "bad", linearIssueIdentifier: "bad" }),
  { sentryIssueUrl: null, linearIssueUrl: null },
  "legacy or corrupted values never become clickable links",
);

const schema = read("prisma/schema.prisma");
assert.match(schema, /sentryIssueId\s+String\?/);
assert.match(schema, /linearIssueIdentifier\s+String\?/);
assert.match(schema, /@@index\(\[sentryIssueId\]\)/);
assert.match(schema, /@@index\(\[linearIssueIdentifier\]\)/);

const route = read("src/app/api/admin/support/route.ts");
assert.match(route, /parseSupportObservabilityUpdate\(body\)/);
assert.match(route, /sentryIssueId:\s*true/);
assert.match(route, /linearIssueIdentifier:\s*true/);
assert.match(route, /sentryIssueId:\s*observability\.data\.sentryIssueId/);
assert.match(route, /linearIssueIdentifier:\s*observability\.data\.linearIssueIdentifier/);
assert.match(route, /buildSupportObservabilityLinks\(ticket\)/);

const adminPage = read("src/app/(dashboard)/admin/page.tsx");
assert.match(adminPage, /sentryIssueReference:\s*ticket\.sentryIssueId/);
assert.match(adminPage, /linearIssueReference:\s*ticket\.linearIssueIdentifier/);
assert.match(adminPage, /sentryIssueId:\s*draft\.sentryIssueReference/);
assert.match(adminPage, /linearIssueIdentifier:\s*draft\.linearIssueReference/);
assert.match(
  adminPage,
  /href=\{ticket\.sentryIssueUrl\}[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"/,
  "saved Sentry and Linear links open without losing the ticket audit",
);
assert.match(
  adminPage,
  /href=\{ticket\.linearIssueUrl\}[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"/,
  "new tabs cannot control the admin page through window.opener",
);

console.log("verify-support-observability-links: PASS trusted parsing, API persistence, and admin links");
