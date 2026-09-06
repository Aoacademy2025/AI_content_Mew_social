# User-controlled narration duration review

Follow-on to the metadata/advisory delivery in PR450. This delivery reads the
existing completed preview's audioDurationMs and voiceUrl, shows the measured
versus requested duration, and offers playback of that delivered take. The
original video preview and export remain available regardless of duration.
Acceptance uses unrounded milliseconds and the unchanged ±10% interval. Old
projects without a target and invalid/unknown durations receive no comparison.

Editing returns to the existing script step. Creating again first opens the
existing RenderReceiptDialog while keeping the completed preview available if
the user cancels. Confirm is the existing ref-guarded job submit with its original
idempotency and billing behavior. Cost disclosure also precedes manual
regeneration when the credits UI is off: it shows minutes, image/allowance and
provider disclosure without claiming credit-funded minute overflow. External
provider charges are explicitly unknown in advance; users are told to check
their provider account. No new provider, billing or render path is introduced.

No automatic regeneration, clipping/stretching, subtitle/export gate, correction
candidate policy or tolerance relaxation. PR449's frozen real takes still score
3/5; this workflow makes the outcome visible and user-controlled, not reliable.

Scoped tests exercise exact boundaries, both failed real takes, passive audio
review, no submission on cost-display render, submit locking and image allowance
blocking with both credit flag values. Full application browser interaction
remains pending local authentication; component rendering is not reported as E2E.
