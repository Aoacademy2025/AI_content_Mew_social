import * as Sentry from "@sentry/nextjs";

import {
  beforeSendSentryEvent,
  beforeSentryBreadcrumb,
  parseSentrySampleRate,
  sentryDataCollection,
} from "@/lib/sentry-config";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const replayErrorRate = parseSentrySampleRate(
  process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_RATE,
  0,
);

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  sampleRate: 1,
  tracesSampleRate: parseSentrySampleRate(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    0.05,
  ),
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: replayErrorRate,
  integrations:
    replayErrorRate > 0
      ? [
          Sentry.replayIntegration({
            maskAllText: true,
            maskAllInputs: true,
            blockAllMedia: true,
          }),
        ]
      : [],
  dataCollection: sentryDataCollection,
  beforeSend: beforeSendSentryEvent,
  beforeBreadcrumb: beforeSentryBreadcrumb,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
