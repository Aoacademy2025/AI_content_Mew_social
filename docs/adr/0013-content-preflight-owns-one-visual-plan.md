# Content Preflight owns one visual plan

Date: 2026-08-17
Status: Accepted

Brand Visual V1 extends the existing Content Preflight into the single structured analysis of a Narrative Source. The same response contains the Content Domain, Dominant Narrative Mode, ranked Treatment Preset candidates, recurring Story Entities and their text-only descriptions, and every ordered Visual Beat with entity references and Scene Intensity. The server resolves a selected catalog ID to the current qualified Treatment Preset Version; the model never invents a top-level treatment or chooses a version.

Treatment ranking follows the Dominant Narrative Mode of the whole source rather than matching isolated words. The analyzer must distinguish literal continuing events from examples, quotations and metaphors: one ghost expression in a business explainer cannot trigger `หนังผีไทย`, while a lesson whose continuing storytelling frame is genuinely supernatural may. Ambiguous narratives still receive one primary recommendation for consistency and two related catalog alternatives for the optional change surface.

Full AI B-roll, AI slots inside AutoMix and Scene Reroll consume the same pinned result and do not call separate treatment, character or per-scene analyzers. This keeps one text-analysis request, one coherent understanding of the story and the existing image count while avoiding contradictory classifications, extra setup, duplicated quota use and additional model latency. Stock-only output and standalone AI Studio do not consume this video-bound plan.
