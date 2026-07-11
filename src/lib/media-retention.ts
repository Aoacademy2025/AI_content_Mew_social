import { storageDaysForPlan, videoExpiryFor } from "@/lib/plan-limits";

export type MediaReference = {
  ownerKind: "video" | "video-job" | "project-draft" | "render-job" | "generated-image";
  ownerId: string;
  expiresAt: Date | null;
  alwaysProtect?: boolean;
};

export function expiryForMedia(plan: string, producedAt: Date): Date {
  return videoExpiryFor(plan, producedAt);
}

export function effectiveMediaExpiry(
  refs: Array<Pick<MediaReference, "expiresAt" | "alwaysProtect">>,
): Date | null {
  if (refs.some((ref) => ref.alwaysProtect || ref.expiresAt === null)) return null;
  return refs.reduce<Date | null>(
    (latest, ref) => (!latest || ref.expiresAt! > latest ? ref.expiresAt : latest),
    null,
  );
}

export function mediaReferenceIsLive(
  ref: Pick<MediaReference, "expiresAt" | "alwaysProtect">,
  now = new Date(),
): boolean {
  return ref.alwaysProtect === true || ref.expiresAt === null || ref.expiresAt.getTime() >= now.getTime();
}

export { storageDaysForPlan };
