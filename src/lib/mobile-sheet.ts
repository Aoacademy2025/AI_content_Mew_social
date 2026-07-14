export type MobileSheetSize = "medium" | "large";

export type SheetDragMotion = {
  distanceY: number;
  velocityY: number;
};

export function shouldDismissSheetDrag({
  distanceY,
  velocityY,
}: SheetDragMotion): boolean {
  if (!Number.isFinite(distanceY) || !Number.isFinite(velocityY)) return false;
  if (distanceY < 0) return false;
  return distanceY >= 96 || velocityY >= 0.65;
}

export function clampSheetDragTranslation(distanceY: number): number {
  return Number.isFinite(distanceY) ? Math.max(0, distanceY) : 0;
}
