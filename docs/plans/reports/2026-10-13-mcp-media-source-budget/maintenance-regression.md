# Unresolved final CI maintenance-response regression

Candidate: `314fe70a9b99bb288cc35156978121901f886bf2` (production code still reviewed `24a7b170`). PR602 converted to draft. GitHub CI38446685316 failed customer-facing-error-copy verification after the preceding MCP/editor/B-roll suites passed.

## Reproduced behavior

The source assertion exposed a real public behavior regression, not merely a relocated constant. Under `render_deploy_drain=1`, an ordinary authenticated fixture owner prepares and approves a quote, then consumes it through the actual public create_video_job transport. The atomic create correctly refuses and funding is unchanged, but the reply loses the existing maintenance classification/message:

```json
{"error":"internal_error","message":"เกิดข้อผิดพลาดภายใน ลองใหม่อีกครั้ง"}
```

Baseline public behavior was `error: render_maintenance`, `retryable: true`, with the shared `RENDER_MAINTENANCE_CUSTOMER_MESSAGE`: ระบบเรนเดอร์กำลังปรับปรุงชั่วคราว กรุณาลองใหม่.

The actual route probe exits **1**: one message assertion failed, funding-unchanged assertion passed. Log: `/tmp/mcp-maintenance-final-probe.log`. Probe copy: `/tmp/mcp-maintenance-final-probe.ts`. Durable reproduction patch is adjacent `maintenance-regression-probe.patch`; copy the current `scripts/verify-mcp-edit-draft.ts` to `scripts/.mcp-maintenance-final-probe.ts`, apply that patch to the copy, then run from the repository:

```sh
DATABASE_URL=file:/tmp/mcp-maintenance-final-unused.db node --import ./scripts/register-server-only-node.mjs --import tsx scripts/.mcp-maintenance-final-probe.ts
```

The fixture itself creates disposable SQLite, uses local auth/provider stubs and performs no production action. Remove copied env files before any imports, without reading their contents.

## Smallest remaining correction

Restore the specific maintenance error envelope at the public approved-creation boundary, using the shared customer message and actionable retry guidance. Preserve the authoritative transactional drain check and rollback; do not bypass maintenance or change reservations. Extend the actual public regression for maintenance refusal and unchanged quote/funding/job identity. Adjust the existing source-location assertion only to the real corrected boundary; do not suppress its behavior requirement.

Re-run targeted quote/create/customer-copy tests, TypeScript/lint and GitHub CI. Any further changes must remain within authorized scope. No new automatic agent run: current approved ceiling25/25 is exhausted. A bounded worker continuation requires explicit extension.

## Other CI fixture corrections already completed

Obsolete onboarding description expectations, editor exact-replay imports, and B-roll/ffmpeg route import harnesses were updated and independently run by the coordinator. Onboarding118, editor recovery, full ffmpeg-input hardening, B-roll coverage/upload admission, scoped lint and TypeScript passed. No production source changed after the independent correctness/security PASS at24a7b170. This newly confirmed maintenance response issue remains open and prevents final acceptance.
