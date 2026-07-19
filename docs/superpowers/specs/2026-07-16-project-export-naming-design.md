# Project Export Naming Design

**Date:** 2026-07-16

## Goal

Make exported videos consistently use the user's meaningful Editor Project title in the Gallery and as the downloaded `.mp4` filename. Keep the existing headline/script fallback for videos that are not linked to a meaningfully named project.

This change does not add B-roll enable/disable controls.

## Naming Rules

The shared display-name resolver uses this precedence:

1. A non-empty Project title other than the default `New Project`.
2. The linked Content headline.
3. A short prefix from the video's non-empty script.
4. `Untitled`.

Whitespace is trimmed before checking a candidate. `New Project` is compared after trimming and is treated as an unset default rather than a user-selected title.

The shared download-name resolver starts from the display name, removes control characters and characters invalid in common Windows/macOS filenames, collapses repeated whitespace, removes trailing dots/spaces, applies a conservative length limit, and appends `.mp4`. If sanitization removes the whole name, it uses `Untitled.mp4`.

Thai and other Unicode letters are preserved.

## Data Flow

`GET /api/videos` will include the linked project's title in its existing Prisma selection. Gallery video items will accept that relation and call the shared resolver rather than owning a separate fallback expression.

Editor v2 already has `projectTitle` in `useV2Project`. `EditorV2Shell` will derive the shared download filename and pass it to every completed-export download surface, including desktop Post, mobile Post, and the resumed exported view. Gallery download links use the same resolver with the project title returned by the API.

The private render object name remains cryptographically random. Only the user-facing `download` filename changes; storage URLs and media-serving security are unchanged.

## Components

- A small client-safe library owns display-title resolution and filename sanitization.
- The videos API adds only `project.title` to the existing response shape.
- Gallery and Editor download anchors receive an explicit `download` value.
- Post-phase components receive the resolved filename as a prop; they do not duplicate naming rules.

No database migration or new download endpoint is required.

## Error and Compatibility Behavior

- Videos without a project keep the existing headline/script/`Untitled` behavior.
- Projects deleted after export leave `Video.projectId` null through the existing relation rule; fallback naming still works.
- Old jobs and old Gallery rows require no backfill.
- If a browser ignores the `download` attribute, the existing random render URL remains a safe fallback and playback is unaffected.

## Verification

Test-first coverage will verify:

- a meaningful Project title wins over headline and script;
- `New Project` falls back to headline/script;
- empty candidates become `Untitled`;
- Thai names remain readable;
- forbidden filename characters, control characters, trailing dots/spaces, and excessive length are sanitized;
- every completed-export download surface supplies the shared filename;
- the Gallery API returns `project.title` and Gallery rendering uses it.

The focused regression verification, TypeScript/build verification, and relevant existing project checks will run before completion is reported.
