---
status: accepted
---

# Only technical generation failure retries automatically

The Grok Subscription Worker retries a timed-out, crashed or assetless command once. A second technical failure pauses only the affected work as Needs Attention, preserves existing assets and approvals, and never changes Narrative Generation Backend. A successfully delivered but aesthetically rejected asset receives no automatic retry; only Mew may request its Scene Reroll or Motion Reroll. Hero exposes each scene's Generation Attempt Count and warns before a third creative attempt. This follows the proven `mewcontent` worker behavior while preventing hidden allowance consumption and separately billed fallback.
