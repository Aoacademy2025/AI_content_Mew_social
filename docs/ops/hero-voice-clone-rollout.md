# Hero Voice Clone — rollout and rollback

Status: code-ready, admin-only, deploy pending an empty render/voice queue.

## What ships

- Additive `UserVoice` table; no existing row is rewritten.
- Private reference WAV storage outside `public/` (default:
  `/var/www/ai-content/uploads/user-voices`).
- One durable RunPod v2 path for stock TTS and clone generation. Clone reference
  bytes are sent per provider request and are never persisted in job JSON.
- Clone upload, preview, delete, and generation remain restricted to `ADMIN`,
  the existing Hero Voice user allowlist, and a dedicated fail-closed flag.

## Before deploy

1. Wait until render and voice queues are empty; keep the existing deploy drain
   gate enabled.
2. Back up the production database.
3. Confirm the application user can create an owner-only directory at
   `/var/www/ai-content/uploads/user-voices`, or set an absolute persistent
   `USER_VOICE_STORAGE_DIR` owned by the application user.
4. Keep `HERO_VOICE_CLONING_ENABLED=0` (or unset) for the code/schema deploy.
5. Deploy normally with `bash deploy/deploy.sh`. Production intentionally uses
   drift-aware `prisma db push` for its legacy SQLite database; without
   `--accept-data-loss`, this applies the additive `UserVoice` table or aborts
   before build/restart. The checked-in migration remains the clean-database
   and CI baseline.

## Private canary

1. Set `HERO_VOICE_CLONING_ENABLED=1` in the production PM2 environment and
   restart only after the queue is empty.
2. Sign in with an allowlisted admin account.
3. In AI Studio → โคลนเสียง, record 7–10 seconds in a quiet room and enter the
   exact transcript.
4. Generate this mixed-language canary:

   `สวัสดีครับ นี่คือ Hero AI Voice test number 123 และปี 2026`

5. Verify upload/preview, queued job progression, playable result, minute
   settlement, and reference deletion after the job reaches a terminal state.
6. Confirm a non-admin allowlisted account cannot see or call clone routes.

## Rollback

Set `HERO_VOICE_CLONING_ENABLED=0` and restart the web/background processes.
This hides clone UI, blocks clone management/submission routes, and leaves stock
Hero Voice available. Do not remove the `UserVoice` table or private files during
an incident rollback. Existing active clone jobs should be allowed to settle or
be canceled/refunded before disabling the flag.

The code can then be reverted independently. Retained reference files must be
deleted only through the authenticated product route or a separately reviewed
data-removal operation.
