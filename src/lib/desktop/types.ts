export type TranscriptSegment = { text: string; start: number; end: number }          // seconds, source-footage clock
export type TalkingInput = { footageId: string; durationSec: number; transcript: TranscriptSegment[] }
export type Overlay = { productFootageId: string; anchor: { talkingFootageId: string; segmentIndex: number }; lenSec: number } // shown from the anchored segment's start
export type VersionPlan = { index: number; sequence: string[]; overlays: Overlay[]; headline: string; caption: string; distinctness: "สูง"|"กลาง"|"ต่ำ"; rationale: string }
export type PlanVersionsRequest = { product: { name: string; description: string; savedHeadlines: string[] }; talking: TalkingInput[]; productFootage: { footageId: string; durationSec: number }[]; n: number; style: "sunrise"|"ocean"|"mono"; existing?: VersionPlan[]; regenerateIndex?: number }
export type PlanVersionsResponse = { maxVersions: number; clampedReason?: string; versions: VersionPlan[] }   // regenerateIndex set → versions has exactly one item, distinct from every `existing`
export type PlanSplitRequest = { footageId: string; durationSec: number; transcript: TranscriptSegment[] }
export type PlanSplitResponse = { segments: { start: number; end: number; headline: string; caption: string; reason: string }[] }
