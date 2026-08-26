/**
 * A notification link is a click target rendered inside the app shell, so it must never
 * be able to send a user off-site (or into a javascript: URL). Accept only a plain
 * same-origin path: a single leading "/" — "//host" and "/\host" are both rejected
 * because browsers resolve them as protocol-relative URLs.
 *
 * Kept in its own module (no prisma) so both the client bell and the pure verify
 * script can apply exactly the same rule.
 */
export function isSafeNotificationLink(link: string | null | undefined): link is string {
  return typeof link === "string" && /^\/(?![/\\])/.test(link) && link.trim() === link;
}
