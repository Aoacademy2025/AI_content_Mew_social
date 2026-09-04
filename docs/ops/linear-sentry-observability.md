# Linear + Sentry operating model

This runbook defines the single path from a production signal to a verified HERO AI Studio fix.

```text
Sentry detects and groups an error
             │
             ▼
Linear Triage ──► Ready ──► In Progress ──► In Review
                                                │
                                                ▼
                                      Ready to Deploy
                                                │
                                      deploy + smoke test
                                                ▼
                                               Done
```

Sentry is the evidence source. Linear is the system of record for decisions and delivery. Do not create a Linear issue for every Sentry event; create one for a grouped, actionable production problem.

## Linear workspace

- Team: `HERO Studio` (`HERO`), public so the Sentry integration can create issues.
- Workflow: `Triage`, `Backlog`, `Ready`, `In Progress`, `In Review`, `Ready to Deploy`, `Done`, `Canceled`. Keep Linear's reserved `Duplicate` state.
- Priorities: Urgent = customer-blocking outage/payment/data loss; High = multiple customers or core workflow; Medium = normal planned work; Low = polish or low-frequency edge case.
- Type labels: `Bug`, `Feature`, `Improvement`, `Research`, `Ops`.
- Area labels: `Editor`, `Render`, `Voice`, `Subtitle`, `B-roll`, `Brand`, `Billing`, `Growth`, `Infra`.
- Execution labels: `Agent-ready`, `Mew-decision`, `Manual-action`.
- Risk labels: `Production`, `Billing-Security`, `Schema-Data`.

Every issue must have one type, one area, an owner, a priority, and a testable acceptance criterion before it moves to `Ready`. A merged pull request moves to `Ready to Deploy`; only a successful production deploy and smoke test moves it to `Done`.

Branch and pull request titles must include the Linear issue key, for example `HERO-123 fix export timeout`. Keep only one canonical work item in Linear after the GitHub migration.

## Sentry project

- Project slug: `hero-studio-web`.
- Platform: Next.js (`javascript-nextjs`).
- Error event sampling: 100%.
- Trace sampling: 5% by default; change through environment variables only after reviewing quota and usefulness.
- Session replay: off by default. If temporarily enabled for error sessions, all text and inputs stay masked and all media stays blocked.
- Source maps: uploaded only during the production build, then removed from the public build output.
- Active email alerts: Sentry's high-priority issue rule plus `New issue or regression` for the `HERO Studio` team.

The SDK explicitly disables collection of cookies, HTTP headers and bodies, URL query parameters, GraphQL documents and variables, generative-AI inputs and outputs, database query data, user information, and stack-frame local variables. The `beforeSend` guard removes user data and redacts secret-like keys as a second boundary.

## Production environment

Store values only in the protected production environment. Never commit the token or paste it into chat.

```dotenv
SENTRY_DSN=<server-side DSN>
NEXT_PUBLIC_SENTRY_DSN=<same project DSN>
SENTRY_ENVIRONMENT=production
NEXT_PUBLIC_SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.05
NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=0.05
NEXT_PUBLIC_SENTRY_REPLAY_ERROR_RATE=0
SENTRY_ORG=<organization slug>
SENTRY_PROJECT=hero-studio-web
SENTRY_AUTH_TOKEN=<build-only token with release/source-map scope>
```

The DSN is intentionally available to the browser and is not an authorization token. `SENTRY_AUTH_TOKEN` is sensitive, must never use a `NEXT_PUBLIC_` prefix, and is needed only while building/uploading source maps.

After changing production environment values, use the repository's normal deploy procedure so the public variables are embedded in the client build and PM2 receives updated server variables.

## Alert-to-issue policy

Create or escalate a Linear issue when any of these are true:

1. Payment, webhook, database, sign-in, render, or export is unavailable to a customer.
2. A new production regression affects at least 3 users or produces at least 10 events in 15 minutes.
3. A critical route's error rate exceeds 5% for 10 minutes.
4. A single event indicates possible data loss, incorrect billing, or a security boundary failure.

All automatically created issues enter `Triage` with the `Bug` and `Production` labels, a Sentry link, first/last seen time, affected release, event count, user-impact count, and a concise reproduction clue. Mew assigns priority/owner after triage; automation must not guess business priority from raw event volume alone.

Resolve the Sentry issue only after the linked Linear issue reaches `Done` and the release containing the fix is healthy. If Sentry marks a regression after resolution, reopen the same Linear issue unless the cause is demonstrably different.

## Verification

Before merge:

```bash
npm run verify:sentry-config
npx eslint next.config.ts sentry.server.config.ts sentry.edge.config.ts \
  src/instrumentation.ts src/instrumentation-client.ts \
  src/lib/sentry-config.ts src/app/global-error.tsx
npx tsc --noEmit
npm run build
```

After deployment, generate one controlled test error without customer data, confirm that its stack trace is symbolicated, link it to a Linear triage issue, then archive both test records. Do not leave a public error-generation route in the application.
