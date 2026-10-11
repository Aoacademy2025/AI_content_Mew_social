---
status: accepted
---

# Media Import accepts any public HTTPS host, guarded per hop, plus a one-time upload link

Agents of many kinds (Grok bot, claude.ai, Codex, Claude Code, OpenClaw, Hermes, Muse AI) must bring their own images and videos into Hero: generated B-roll and a HeyGen-rendered Uploaded Presenter Video. Agents without a shell can only hand us a link, and we cannot know in advance which host serves a generated file. So Media Import fetches from **any public HTTPS host** instead of an allowlist. Every redirect hop is re-checked with `safe-fetch`, the download is streamed against the web upload's byte cap, and ffprobe checks what the file really is, never the declared type alone. Agents with a shell but no public link use a single-use, short-lived upload link instead. Both paths converge on the same validation and normalisation the web upload uses.

## Considered Options

- **Host allowlist.** Rejected. Generated-media hosts are unknown and change, so the allowlist would break the agents this feature exists for.
- **URL only.** Rejected. Local-file agents (Codex, Claude Code) would have no way to send a file.

## Consequences

- This is a server-side fetch of attacker-chosen URLs, so the guard (public-IP check on every resolved address and every hop, HTTPS only, byte cap enforced while streaming, admission limits) is a security boundary and is reviewed as one.

## Implementation notes (2026-10-04, PR #572)

- **The fetch is pinned to its checked address.** Every hop resolves the host once, checks the address with `ipIsPrivate`, and connects to that exact IP. Only port 443 is used, the host's own interface addresses are refused, and at most 5 redirects are followed. A second DNS lookup cannot rebind the connection to another address.
- **The disk has a floor.** The upload PUT and the import lane both check free space on the disk they write to: the staging disk, `public/renders`, or `stocks`. If space is short, or statfs fails, the import is refused with `storage_busy` and nothing is charged. The per-user byte budget once owed here (plan follow-up 1) shipped with the capacity guards below.
- **The upload-link token is a credential.** It is stored only as a SHA-256 hash and works once. nginx logs `/api/mcp-uploads/` in a redacted format, and Sentry and the MCP audit scrub it. Plain http is answered with 403 rather than redirected.

## Implementation notes (2026-10-11, capacity guards before the public flag)

- **Every import counts bytes.** `MediaImport.bytes` (additive column) holds the declared Content-Length while an upload streams in, then the bytes staged or fetched. A row whose size is still unknown (a queued url, a chunked upload) counts as its purpose's byte cap. Failed and expired rows count nowhere.
- **Per-user byte budgets** (plan follow-up 1): ready and live imports may total at most 2 GiB in any rolling hour and 3 GiB in any rolling 24 h. A refusal (`import_bytes_hourly_limit` / `import_bytes_daily_limit`) charges nothing and carries `retryAfterSeconds`: when enough counted bytes leave the window.
- **Staging fair share** (follow-up 4): one user's live imports may hold at most 1.5 GiB (three presenter clips) of the global staging budget, now 15 GiB, so it takes ten accounts at their full share to fill it (`active_import_bytes_limit`, `retryAfterSeconds` 30).
- **The PUT floor counts in-flight bytes** (follow-up 2): the free-disk check runs inside the admission transaction and adds every upload still streaming in or import being processed.
- **Bursts** (EP5 backlog #16): the 429s on a 9-file batch were the 3-active-import cap. It is now 12 (a typical video's windows in one burst; a bigger batch waits `retryAfterSeconds` and re-PUTs on the same links), bounded by the byte share, and a queued import waits up to 30 minutes for the lane. The lane picks candidates per user, so a user queued behind other users' full bursts is not starved.
- Every limit is overridable by environment variable (names in `src/lib/media-import/limits.ts`); a malformed or too-small value falls back to the default.
