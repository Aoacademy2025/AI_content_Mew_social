import "server-only";

import { createOmniVoiceAdmissionCounter } from "@/lib/omnivoice-core";

// Matches the worker's one active + two pending admission envelope. This guard
// prevents an unbounded number of app requests from waiting on those three slots.
export const omnivoiceAdmission = createOmniVoiceAdmissionCounter(3);
