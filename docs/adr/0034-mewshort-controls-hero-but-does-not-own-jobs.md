---
status: accepted
---

# Mewshort controls Hero but does not own jobs

Mew starts and steers the workflow from chat in the `mewcontent` project through a new `mewshort` skill, which invokes Hero MCP and returns direct Hero review links. Hero remains the authoritative owner of the video project, Storyboard and Keyframe approvals, job lifecycle and render inputs, while the Mac mini worker remains the only Grok execution boundary. Keeping orchestration out of the content repository avoids a second job state machine and distinguishes `mewshort` from the existing `mew-story` and `mew-yt` production skills.
