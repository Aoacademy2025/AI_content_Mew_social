---
status: accepted
---

# One worker leases at most two Grok jobs

The Mew-only pilot runs one Grok Subscription Worker with a shared FIFO image-and-video queue and a global concurrency limit of two, matching the proven `mewcontent` operating limit. Each claimed job receives an exclusive lease renewed by heartbeat; if the worker disappears, Hero returns the unresolved job to Waiting for Grok Worker only after lease expiry and does not count an attempt until submission to Grok is confirmed. Pausing a Story Film prevents new leases while allowing already executing jobs to report their results. Queue availability never bypasses Storyboard, Character, Look, Keyframe or Video approval gates.
