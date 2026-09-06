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
review, cost disclosure and image allowance blocking with both credit flags.
The actual Editor shell runtime exercises Cancel, Edit -> Render, same-tick double
confirmation, and project replacement while unconfirmed regeneration intent remains.

Full-application Browser QA passes on desktop and 390px mobile: the completed-job
fixture plays the original 34.370958-second failed take, shows 34.37 versus 30,
keeps export available and preserves preview on receipt cancellation. Edit ->
Render displays cost before submission. Gateway evidence records zero job requests
before confirmation and one after a deliberate confirmation; the local gateway
rejects that request before any provider call. This tests dispatch, not a new
paid generation or its billing settlement.

The app and APIs run unchanged against synthetic SQLite data through the existing
service-actor authentication seam. Clerk login and production are not covered.
The completed VideoJob and neutral video are fixtures, while the WAV is retained
from PR449. No provider spend, new TTS take or modified acceptance score occurred.
Production build, review and final CI status are recorded in the PR.
