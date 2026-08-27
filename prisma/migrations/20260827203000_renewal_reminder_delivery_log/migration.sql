CREATE TABLE "RenewalReminderLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "termExpiresAt" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CLAIMED',
    "notificationDelivered" BOOLEAN NOT NULL DEFAULT false,
    "emailAttempted" BOOLEAN NOT NULL DEFAULT false,
    "emailDelivered" BOOLEAN NOT NULL DEFAULT false,
    "failureCode" TEXT,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "RenewalReminderLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RenewalReminderLog_userId_termExpiresAt_kind_key"
ON "RenewalReminderLog"("userId", "termExpiresAt", "kind");

CREATE INDEX "RenewalReminderLog_status_attemptedAt_idx"
ON "RenewalReminderLog"("status", "attemptedAt");

CREATE INDEX "RenewalReminderLog_kind_termExpiresAt_idx"
ON "RenewalReminderLog"("kind", "termExpiresAt");
