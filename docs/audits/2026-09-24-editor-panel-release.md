# Desktop editor panel resize — release record

**Deployed successfully September 24 at 16:50:28 UTC / 23:50:28 Bangkok.** Production head `8e0f69d48865f3e1a80a528cf5843a6cb21693ba`, build ID `AF38ZwrdRJ5WMWsqfwNTv`. Native deploy exited 0 with no retry or CI override. Automatic behavior checks and public-asset verification passed; the logged-in UI check limitation remains below.

Mew approved merging and deploying PR #550 after the support tickets were closed. This release covers desktop panel resizing only; it does not add Direct URL or close the unrelated HERO-10/41/51 and build-memory investigations.

- PR: https://github.com/Aoacademy2025/AI_content_Mew_social/pull/550
- Reviewed/tested head: `873151091ddc3a49221fbec5578a0d6f0d790066`
- Squash merge on main: `8e0f69d48865f3e1a80a528cf5843a6cb21693ba`, merged September 24 at 16:30:54 UTC
- Tree equality between the tested PR head and merged main verified with `git diff --exit-code`.
- PR CI passed on attempt 2: https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/36025067530
- Exact-main CI: https://github.com/Aoacademy2025/AI_content_Mew_social/actions/runs/36027899546 — passed. Exact-head check-runs API independently returned Build completed/success and main still pointed at the authorized merge immediately before launch. No CI override was used.

## Admission and backup

At 16:30:52 UTC production remained on `9c0fd51cf8403a5d075168ec2c9f1d52ea6c14c7`, build `dFhcZ6HAeEblnJc6zI_5P`, with clean tracked files, zero VideoJobs/RenderJobs in flight, maintenance off, drain 0, all four cleanup units inactive and all critical workers online with zero unstable restarts. Available memory: 30,341,508 KiB.

Online SQLite backup completed at 16:31:26 UTC: 675,790,848 bytes, 2.52 seconds, quick_check `ok`. Private host path: `/var/backups/heroai/panel-resize-20260924/pre-8e0f69d4.sqlite`, mode 0600. No database or customer media was copied off host.

The prepared private launcher retains the native drain, queue, dependency, schema, staged-build, maintenance and health/rollback gates and the established 4096/512 nominal heap inputs (3072/512 fallback). Existing customer work must be allowed to finish. No unrelated configuration change is part of this release.

Admission was refreshed at 16:42:04 UTC: same healthy original release, clean tracked files, queues 0/0, maintenance off, drain 0, cleanup units inactive, unchanged worker restart counts. Native deployment was launched shortly afterward with a persisted private log and exit receipt.

## Verification scope

Local browser behavior, preview/B-roll layout, native media keyboard checks, TypeScript and production build previously passed. New files pass ESLint; PostPhase retains the same 136 pre-existing refs-rule findings as its base.

Browser plugin discovery returned no available browser. A logged-in production editor UI session therefore remains unavailable. Post-deploy verification ran the shipped browser behavior harness on the production host against synthetic content, under a temporary systemd unit configured with CPU 100%, memory 2 GiB, 90-second runtime limit and external-network denial with localhost allowed. It passed pointer/keyboard resizing, reload persistence, responsive/B-roll layouts and invalid/unavailable storage. The smoke unit exited successfully and is inactive. This does not claim a customer-session or customer-media test.

The public chunk `static/chunks/app/(dashboard)/video-editor/page-6bb5cf89a57a028a.js` returned HTTP 200, matched the deployed file hash and contained both resize handles and the remembered-width storage key.

At 16:50:52 UTC the exact deployed head/build above was verified, tracked files were clean, queues were 0/0, maintenance was off and drain was 0. All critical workers were online with zero unstable restarts; web/MCP/story restarted once (4→5), both render workers once (315→316). Both local and public health returned HTTP 200. The prior build remains available in `.next.old`.

Selected web/worker logs from 16:42:13–16:51:00 UTC contained zero tracked P2028, SQLite busy, transaction-closed, OOM, slow-transaction, socket-timeout, P1008 and React-depth markers, with no rotation/truncation. This short deployment smoke does not resolve the longer-term HERO-10/41/51 or build-memory work.

Private operational scripts and sanitized evidence: `~/.codex/artifacts/hero-panel-release-20260924/`. Persistent deployment log/receipt directory: `/var/lib/heroai/releases/panel-resize-20260924`.

PR description was updated with production evidence. The clean merged implementation worktree `editor-panel-resize-20260924` was removed through Orca; the audit/release records remain in this separate audit worktree, and the next-session handoff was refreshed. Root checkout was not edited or switched.

## Related records

Support `cmuffh4n6013plc6ak9qvy7ns` was explicitly closed by Mew after upload guidance; its closure does not assert that panel resizing was already deployed. Avatar ticket `cmuckt3h401s3lcysj6t7z69j` was independently closed after verified successful Avatar outputs (HERO-45, already Done). No further customer communication or Linear/Sentry state change is part of this release.

## Session close and approved follow-up order

Final operational refresh at 16:59:38 UTC retained the deployed commit/build, clean tracked files, maintenance off, drain 0 and unchanged healthy worker restart counts. Local/public health returned 200. One new customer VideoJob and one RenderJob were active; no intervention was made. These are customer jobs, not unfinished deployment processes.

Mew approved the recommended next-session order: first read natural cleanup/SQLite evidence together, then address the confirmed profiler flag behavior with a matched before/after memory measurement; schedule the reviewed private four-thread long-subtitle experiment during a fresh idle window with its existing cancellation and quality guards. HERO-10 requires the existing seven-day acceptance window. HERO-41 requires natural production evidence. Neither these parent issues nor build-memory optimization was completed by this UI release.

Customer communication still outstanding: the current reply on `cmuffh4n6013plc6ak9qvy7ns` says panel resizing is being improved; no post-deployment completion message has been sent. Mew was explicitly informed of this. A possible completion message for a later authorized follow-up is: “ตอนนี้ปรับขยายแผงซ้าย–ขวาในหน้าตัดต่อได้แล้วครับ รีเฟรชหน้าเว็บแล้วลากขอบแผงเพื่อปรับขนาดได้ ระบบจะจำขนาดที่เลือกไว้ให้ครับ” Preserve the existing reply history/receipt and do not silently resend or reopen the case.

This audit branch is a documentation archive, not a production code base or a pending implementation PR. Feature code is already committed, pushed, merged and deployed through PR #550.
