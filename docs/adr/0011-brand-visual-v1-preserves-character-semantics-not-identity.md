# Brand Visual V1 preserves character semantics, not identity

Date: 2026-08-17
Status: Accepted

Brand Visual V1 provides Semantic Character Consistency: Content Preflight resolves recurring Story Entities from narrative context, creates one text-only Recurring Character Description for an entity that appears across multiple Visual Beats, and reuses it in every relevant scene and Scene Reroll. A name such as Kong must therefore remain an adult Thai human when that is what the story establishes, but text constraints do not imply that every generated appearance has the same face.

Proper names remain internal entity-linkage keys. At the image prompt boundary, the compiler substitutes an Entity Rendering Description that leads with a positive, unambiguous type and durable attributes; it does not send a bare ambiguous name as the visual subject. This is required because the production Z-Image route is positive-only: wording such as `Kong, not a gorilla` cannot rely on a negative-prompt channel, while `an adult Thai human man with short black hair` directly states what the frame must depict. Names remain unchanged in narration and deterministic subtitles.

The description is scoped to one narrative: separate recurring entities receive separate descriptions, scene-specific age or state changes may override the stable attributes, and generic people, crowds or content with no recurring character remain unconstrained. It is never stored in the Brand Profile or carried automatically into a new video; cross-video continuity would be a separate, explicit Series Character capability.

V1 does not accept or transmit a Character Reference and does not use identity conditioning. It adds no character-confirmation screen, extra image generation, hidden retry or mandatory setup field, and Scene Reroll may produce a different-looking person while preserving the same semantic character. Product copy must not promise a locked face or identical character appearance.

Character Identity Lock is a separate future capability because it requires an approved anchor image, a reference-capable generation workflow and its own consistency evaluation. The observed customer defect is a semantic type failure, so V1 fixes that failure without adding the generation dependency, latency and cost of an identity pipeline before recurring-character demand is established.
