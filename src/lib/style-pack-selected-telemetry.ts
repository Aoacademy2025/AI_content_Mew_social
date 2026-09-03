import { isStylePackId } from "@/lib/style-pack-catalog";
import { recordTelemetryEvent } from "@/lib/telemetry";

/** Defensively read the pinned Style Pack off a PERSISTED Brand Profile
 * Revision's `payloadJson` and, when one is present, emit `style_pack_selected`
 * (`surface: "brand"`). This is the fix for a real bug (review finding,
 * 2026-09-03): a bare `JSON.parse(revision.payloadJson)` in the publish route
 * sat OUTSIDE any try/catch — a malformed or legacy `payloadJson` (missing
 * `visual`) would throw, get caught by the route's OUTER catch, and report a
 * successful publish as a failed request even though `publishBrandProfileDraft`
 * and `brand_profile_revision_published` had already succeeded.
 *
 * The WHOLE emit — parse, property read, and the telemetry write itself — is
 * wrapped in one try/catch here, so this function can NEVER reject and NEVER
 * throw: a telemetry side-effect must never turn an already-successful
 * publish/create into a reported failure. Callers can `await` this directly
 * with no `.catch()` of their own.
 *
 * Shared by every brand-surface site that reads a pack off a persisted
 * Revision's `payloadJson` specifically. It does NOT apply to a site reading
 * `visualRecipeJson` instead (that shape nests the pack under `.stylePack`,
 * not `.visual.stylePackId`, and already goes through the separately-guarded
 * `stylePackSnapshotFromJson`). */
export async function emitStylePackSelectedFromRevision(
  userId: string,
  revision: { payloadJson: string },
  step: string,
): Promise<void> {
  try {
    const parsed = JSON.parse(revision.payloadJson) as {
      visual?: { stylePackId?: unknown; stylePackVersion?: unknown };
    };
    const packId = parsed?.visual?.stylePackId;
    if (!isStylePackId(packId)) return;
    const version = parsed.visual?.stylePackVersion;
    await recordTelemetryEvent(userId, {
      name: "style_pack_selected",
      source: "server",
      step,
      properties: {
        packId,
        surface: "brand",
        version: typeof version === "string" ? version : null,
      },
    });
  } catch {
    // A telemetry side-effect can never fail an already-successful
    // publish/create — malformed JSON, a legacy shape missing `visual`, or a
    // DB write failure all resolve silently here.
  }
}
