/**
 * prisma-errors.ts — classify a thrown error as "the database was too busy to
 * finish this write", as opposed to any other failure (validation, a real
 * constraint violation, a provider error, a bug).
 *
 * Used by the MCP transport (src/app/api/[transport]/route.ts) to answer a
 * tool call in-band as `database_busy` instead of a generic `internal_error`
 * when the underlying cause is SQLite writer-lock contention (busy_timeout
 * steps, Prisma's transaction queue timing out, a socket timeout on a pooled
 * connection). See docs/ops/... and CLAUDE.md for the prod background
 * (2026-10-12).
 *
 * Deliberately narrow: P2002 (unique constraint) and other real errors must
 * NOT be reclassified as busy — only the codes/substrings below, which are
 * the ones actually observed in prod logs for this failure class.
 */

import { isTransientSqliteError } from "@/lib/sqlite-retry";

/** Prisma error codes that mean "the write could not get the SQLite lock/slot in time." */
const BUSY_CODES = new Set(["P1008", "P2028", "P2024"]);

/** Substrings of the error message that mean the same thing, for errors that
 *  don't carry one of BUSY_CODES (e.g. a raw driver error, or a message-only
 *  wrapper around the queue timeout / socket timeout). Matched case-sensitively
 *  against the exact strings Prisma/SQLite emit — no broad case-insensitive
 *  net, so an unrelated message never gets swept in. */
const BUSY_MESSAGE_SUBSTRINGS = ["database is locked", "SQLITE_BUSY", "Socket timeout"];

function messageOf(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function codeOf(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as { code?: unknown }).code;
}

/**
 * True when `error` represents a transient SQLite writer-lock stall rather
 * than a real failure — Prisma P2028 (unable to start/continue a transaction,
 * including this process's own transaction-queue timeout, see
 * prisma-transaction-queue.ts), P1008 (operation timed out) or P2024 (timed
 * out fetching a connection from the pool), or a message containing
 * "database is locked", "SQLITE_BUSY" or "Socket timeout".
 *
 * Not P2002 (unique constraint) or any other error shape.
 */
export function isDatabaseBusyError(error: unknown): boolean {
  if (isTransientSqliteError(error)) return true; // P1008 / P2028
  if (BUSY_CODES.has(String(codeOf(error)))) return true;
  const message = messageOf(error);
  return BUSY_MESSAGE_SUBSTRINGS.some((needle) => message.includes(needle));
}
