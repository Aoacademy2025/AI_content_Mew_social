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
- **The disk has a floor.** The upload PUT and the import lane both check free space on the disk they write to: the staging disk, `public/renders`, or `stocks`. If space is short, or statfs fails, the import is refused with `storage_busy` and nothing is charged. A per-user byte budget is still owed before the public flag (plan follow-up 1).
- **The upload-link token is a credential.** It is stored only as a SHA-256 hash and works once. nginx logs `/api/mcp-uploads/` in a redacted format, and Sentry and the MCP audit scrub it. Plain http is answered with 403 rather than redirected.
