# System treatment placeholders are repairable

Date: 2026-08-17
Status: Accepted

A persisted per-video treatment is normally authoritative, but an exact system-authored Generic Treatment Placeholder saved before the corresponding Content Preflight completed is not creator intent and is not a valid Treatment Pin. Brand Visual V1 may apply a Targeted Visual Repair only when both facts are provable, replacing that placeholder with the completed Suggested Treatment while preserving the project's Visual Format, Brand Profile Revision, Brand Visual Language and existing image assets.

The repair never matches arbitrary free text, never changes a creator-selected treatment and never generates or charges for an image by itself. Existing frames remain intact; only later generation and explicit Scene Rerolls use the repaired Treatment Pin. This narrow exception lets the customer projects behind the observed support tickets benefit from the fix without silently migrating unrelated pinned work or adding a legacy-remediation screen.

A creator-authored free-form value is a Legacy Custom Treatment, not a placeholder. It remains readable and reproducible for that existing project and its Scene Rerolls, but is no longer editable or creatable in new projects. The UI identifies it in plain language as `ใช้แนวที่ตั้งไว้เดิม`; choosing a catalog option follows the explicit complete-image-set regeneration-or-cancel rule rather than silently mapping the creator's wording.

After the global release, the two source support tickets remain the direct customer verification path. The team replies with the concrete fixes and asks the creator to use the existing `ลองภาพนี้ใหม่` action on the affected scenes; the system does not generate or alter a customer asset on their behalf. The tickets remain open until the creator confirms the result or the normal no-response follow-up policy completes, while aggregate behavior contributes to First-pass Visual Acceptance without exposing the account.
