/** Desktop API is inert unless DESKTOP_APP is exactly "1". */
export function isDesktopEnabled(): boolean {
  return process.env.DESKTOP_APP === "1";
}

/**
 * When DESKTOP_ALLOWLIST is a non-empty comma-separated list of Hero AI user ids,
 * only those ids are invited. Empty / unset allowlist = everyone (flag still required).
 */
export function isDesktopInvited(userId: string): boolean {
  const raw = process.env.DESKTOP_ALLOWLIST ?? "";
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return true;
  return ids.includes(userId);
}

/** Settings › อุปกรณ์ที่ล็อกอิน — same gate as the desktop API surface. */
export function canShowDesktopDeviceSeats(userId: string): boolean {
  return isDesktopEnabled() && isDesktopInvited(userId);
}
