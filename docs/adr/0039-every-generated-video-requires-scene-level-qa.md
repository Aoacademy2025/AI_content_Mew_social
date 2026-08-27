---
status: accepted
---

# Every generated video requires scene-level QA

Hero may not assemble the final edit until every AI Video passes the Video QA Gate. Mew resolves each clip independently by accepting it, requesting a Motion Reroll from the same approved Scene Keyframe, returning the scene for Keyframe repair, downgrading it to Still with Motion or removing it. Unresolved clips block rendering, while approved neighboring scenes remain untouched. Hero never hides an unlimited automatic reroll loop; this trades a final manual review for protection against identity drift, malformed motion and unobserved Grok subscription consumption.
