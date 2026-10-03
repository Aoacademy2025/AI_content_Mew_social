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
