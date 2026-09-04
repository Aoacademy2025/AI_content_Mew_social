import * as Sentry from "@sentry/nextjs";

import {
  beforeSendSentryEvent,
  beforeSentryBreadcrumb,
  parseSentrySampleRate,
  sentryDataCollection,
} from "./src/lib/sentry-config";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  sampleRate: 1,
  tracesSampleRate: parseSentrySampleRate(
    process.env.SENTRY_TRACES_SAMPLE_RATE,
    0.05,
  ),
  dataCollection: sentryDataCollection,
  beforeSend: beforeSendSentryEvent,
  beforeBreadcrumb: beforeSentryBreadcrumb,
});
