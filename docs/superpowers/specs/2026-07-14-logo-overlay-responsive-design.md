# Responsive Logo Overlay Design

**Date:** 2026-07-14  
**Status:** Approved in conversation  
**Product area:** Video Editor v2, Step 3 post-render editing  
**Eligible plans:** PRO and BUSINESS

## 1. Context

Two support tickets from an internal PRO tester requested:

1. Uploading a custom logo and choosing where it appears on the finished video.
2. Adding a custom End Scene based on an uploaded image or logo.

The current product North Star is Activation: signup to first completed video. Production evidence showed that the reporter exported successfully immediately after filing the requests, so Logo Overlay is not an activation blocker. It does, however, strengthen the product promise of producing a clip that is ready to publish without a second pass through CapCut or Canva.

This design therefore adds Logo Overlay as an optional post-render enhancement. It must never add a required step before export. End Scene remains a separate later feature.

## 2. Goals

- Let a PRO or BUSINESS user upload a logo once and reuse it across projects.
- Let each project enable or disable the logo independently.
- Let the user choose one of nine safe positions, size, and opacity.
- Show the exact same placement in desktop preview, mobile preview, and exported video.
- Make the mobile interaction touch-native and usable from 360 px through tablet widths.
- Preserve the existing export path by burning the logo in the same pass as subtitles.
- Keep old projects and export payloads without a logo byte-compatible in behavior.

## 3. Non-goals

- End Scene or end-card templates.
- A multi-item Brand Library UI.
- Free dragging or arbitrary x/y positioning.
- Logo animation, entrance effects, or keyframes.
- Per-range display timing or a Logo timeline track.
- Multiple simultaneous logos.
- Changing the FREE-tier HERO watermark policy.

## 4. Approved Product Decisions

- Desktop uses a `ซับ | โลโก้` tab switcher in the existing Step 3 right panel.
- Mobile uses a `โลโก้` action below the sticky preview and opens a bottom sheet.
- The logo is displayed for the full clip.
- Position is selected from a three-by-three grid of nine anchors.
- One account-level default logo can be reused across projects.
- Changing a logo inside a project changes only that project unless the user selects `ตั้งเป็นโลโก้หลักสำหรับโปรเจกต์ใหม่`.
- Logo Overlay is available to PRO and BUSINESS only.
- The default placement is top-right, size is 18% of video width, and opacity is 90%.
- New projects inherit the account default asset and its saved default settings. Existing projects are never changed automatically.

## 5. Desktop UX

Logo controls appear only after the base render is complete, in Step 3.

The existing right settings panel gains a two-tab switcher:

- `ซับ`
- `โลโก้`

The Logo tab has two states.

### 5.1 Empty state

- Short explanation: add a brand logo to the exported clip.
- Primary action: `＋ อัปโหลดโลโก้`.
- Supported formats and the 5 MB limit are shown before the picker opens.

### 5.2 Configured state

- Toggle: `แสดงโลโก้ในโปรเจกต์นี้`.
- Current-logo thumbnail and file label.
- Actions: `เปลี่ยน` and `ลบออกจากโปรเจกต์`.
- Three-by-three position grid with localized accessible labels.
- Size slider with a numeric percentage.
- Opacity slider with a numeric percentage.
- A live preview update for every change.

Changing the asset opens the system picker. After a successful upload, the UI offers:

- `ใช้เฉพาะโปรเจกต์นี้`.
- `ตั้งเป็นโลโก้หลักสำหรับโปรเจกต์ใหม่`.

The second option saves the selected asset and the current position, size, and opacity as the account defaults. It does not rewrite existing projects.

## 6. Mobile UX

The current `PostPhaseMobile` structure remains intact: sticky preview, scrubber, caption list, and persistent export action.

### 6.1 Entry point

Below the preview, show two equal touch actions:

- `แก้ซับ`
- `โลโก้`

The Logo action uses an icon plus text and shows a visible active indicator when the project has Logo Overlay enabled. It does not rely on color alone.

### 6.2 Bottom sheet

Tapping Logo opens a bottom sheet at approximately 60% of viewport height. It reuses the existing mobile Sheet behavior rather than introducing a second modal system.

The sheet contains:

1. Drag handle, title, and close action.
2. Enabled toggle.
3. Current-logo card with replace and remove actions.
4. Nine-position grid.
5. Size slider and numeric value.
6. Opacity slider and numeric value.
7. `เสร็จ` action.

The preview remains visible above the sheet and updates immediately. The sheet content scrolls internally. Closing is supported through `เสร็จ`, close, swipe-down, Escape on a connected keyboard, and Android Back where the existing sheet system can intercept it.

### 6.3 Mobile quality requirements

- Minimum touch target: 44 by 44 CSS pixels.
- Honor top and bottom safe-area insets.
- The position grid must remain comfortably tappable at 360 px width.
- Slider thumbs must be large enough for touch and expose numeric values.
- Body scrolling is locked while the sheet is open; only sheet content scrolls.
- Focus is trapped inside the sheet and returns to the Logo trigger on close.
- The export button remains part of the underlying layout but cannot be accidentally activated through the open sheet.
- Verify at 360, 375, 390, 430, 768, and 1024 px boundaries.

## 7. Placement Model

The nine positions are:

- top-left, top-center, top-right;
- middle-left, center, middle-right;
- bottom-left, bottom-center, bottom-right.

Placement is calculated in normalized video coordinates, not preview pixels. A shared geometry helper converts:

- anchor;
- logo intrinsic aspect ratio;
- size as a percentage of video width;
- safe inset;

into a render box.

The safe inset keeps the logo away from the physical edge and common social-platform overlay zones. The same geometry result is scaled into each preview surface and used directly in the 1080 by 1920 Remotion composition.

Allowed configuration bounds:

- size: 8% to 35% of video width;
- opacity: 20% to 100%;
- position: one of the nine declared anchors.

The server clamps and validates every value; client controls are not authoritative.

## 8. Data Model

### 8.1 Brand asset

Add a dedicated `BrandAsset` record instead of placing image bytes in `User` or `EditorProject.draftJson`.

Required fields:

- id;
- owner user id;
- optional originating project id;
- server-controlled storage key;
- original display name;
- normalized MIME type;
- byte size;
- width and height;
- created and updated timestamps.

Every asset is owned by exactly one user. Project-specific assets remain available to old projects that reference them.

### 8.2 Account defaults

Store one account-level logo preference containing:

- default asset id;
- default anchor;
- default size percentage;
- default opacity;
- default enabled state.

This may be represented by a one-to-one brand preference record. It is separate from project state so replacing a default cannot silently rewrite existing projects.

### 8.3 Project state

Extend the v2 project draft with an optional `logoOverlay` object:

```ts
type LogoOverlayConfig = {
  enabled: boolean;
  assetId: string;
  position: LogoPosition;
  sizePct: number;
  opacity: number;
};
```

Only ids and small scalar settings live in the project draft; no image bytes or data URLs are stored there. The existing one-second autosave persists these settings to `EditorProject.draftJson` and local storage.

## 9. Upload and Asset Security

Add authenticated brand-asset endpoints for:

- loading the account default;
- uploading an asset for the current project;
- optionally setting an asset and its current settings as the new default;
- removing an asset from the current project;
- deleting an unreferenced asset.

Server rules:

- Require PRO or BUSINESS.
- Accept PNG, JPEG, and WebP only.
- Maximum input size: 5 MB, with an early content-length guard.
- Validate extension, declared MIME, and decoded image type.
- Decode through Sharp, apply EXIF orientation, reject either dimension above 4096 px, normalize the longest edge to at most 2048 px, and strip unnecessary metadata.
- Preserve alpha by normalizing to an alpha-capable output where required.
- Use only server-generated storage names.
- Rate-limit uploads per user.
- Never trust a client-provided asset URL or file path.
- Verify both project ownership and asset ownership on every mutation.

Uploaded brand files are durable account/project assets, not temporary render media. Store them under a non-public, server-controlled brand-assets root. An authenticated image route serves preview bytes only after an ownership check; raw storage paths are never returned to the browser. Account deletion removes owned records and files. Replacing a project-only asset removes the previous file only when no project, default preference, or in-flight export references it.

## 10. Shared Preview and Render Architecture

Create two focused shared units:

1. A pure geometry helper that calculates the normalized logo box.
2. A presentational Logo Overlay component that consumes the calculated box and renders the image.

The geometry helper must be usable by browser code and Remotion without importing browser-only or Remotion-only dependencies.

Desktop and mobile previews consume the same project config and geometry. The export payload carries the project `assetId` and scalar settings, not a URL. The export server:

1. Verifies the plan.
2. Loads the asset by id and owner.
3. Resolves the server-controlled asset path.
4. Stages a job-owned snapshot before accepting the export so replacing or deleting the account asset cannot break an in-flight render.
5. Produces the trusted internal logo input for the render job.

Extend `SubtitleOverlayConfig` with an optional trusted logo overlay. `SubtitleOverlayComposition` renders the image above the background video and below subtitles so captions remain readable.

The logo is burned during the existing subtitle burn/export job. It must not create another render job or consume another clip/minute charge.

When the optional logo config is absent, the composition and export behavior are unchanged.

## 11. Error Handling

- Upload failure keeps the previous asset and settings intact.
- Unsupported, oversized, corrupt, or dimensionally unsafe images return a localized reason.
- A temporary network failure leaves local edits visible and shows `ยังไม่ได้บันทึก` until retry succeeds.
- If an enabled asset is missing at export time, export stops with a localized re-upload action. It must not silently export without the logo.
- Export retry reuses the already uploaded asset.
- Removing the account default does not delete assets still referenced by projects or in-flight jobs.
- An archived or deleted project cannot be used to upload or resolve a project-only asset.
- If an account downgrades to FREE, saved logo settings remain in the project but Logo controls are locked and the server rejects logo-enabled export with a localized upgrade message; it never silently removes the logo.

## 12. Accessibility

- Position buttons expose localized names such as `ขวาบน` and `กึ่งกลาง`.
- Toggle, replace, remove, sliders, and done actions have explicit labels.
- Desktop controls work with keyboard navigation.
- Sheet focus is trapped and restored correctly.
- Active and error states use text or icons in addition to color.
- Slider values are available to assistive technology.

## 13. Analytics

Add privacy-safe events for:

- Logo panel opened;
- upload started, succeeded, or failed by normalized error category;
- overlay enabled or disabled;
- default-logo preference saved;
- export submitted and completed with a logo.

Do not log filenames, asset URLs, storage keys, or image contents.

Evaluate the feature primarily against export completion and repeat-creator behavior, not signup-to-first-video Activation. The UI must remain optional so it cannot reduce the Activation North Star.

## 14. Testing and Acceptance

### 14.1 Logic and security

- Geometry tests cover all nine anchors, aspect ratios, size bounds, opacity bounds, and safe insets.
- API tests cover FREE denial, PRO/BUSINESS success, cross-user asset denial, project ownership, rate limits, and corrupt files.
- Project draft tests cover save, reload, legacy draft compatibility, and initialization from account defaults.
- Export validation rejects missing or foreign assets.

### 14.2 Rendering

- Preview and Remotion use the same geometry fixtures.
- Transparent logos keep alpha.
- Subtitles remain above the logo layer.
- Exports without Logo Overlay remain unchanged.
- Logo export stays inside the existing paid burn and does not add a quota charge.

### 14.3 Responsive UX

- Desktop Logo tab works at supported desktop widths.
- Mobile bottom sheet is tested at 360, 375, 390, 430, and 768 px.
- The 1023-to-1024 px breakpoint switches cleanly between mobile and desktop layouts.
- Touch targets, safe areas, internal scroll, focus management, and Android Back behavior are verified.
- A real-device smoke check is performed on one iPhone-class viewport and one Android-class viewport.

### 14.4 User acceptance

An eligible PRO or BUSINESS user can:

1. Open an existing rendered project.
2. Upload a transparent logo from mobile.
3. Select top-right, change size and opacity, and see live feedback.
4. Close and reopen the project with settings preserved.
5. Export once and receive a video matching the preview.
6. Start a new project and inherit the explicitly saved default.
7. Disable or replace the logo without affecting older projects.
