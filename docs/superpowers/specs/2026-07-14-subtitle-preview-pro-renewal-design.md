# Subtitle Preview Fidelity and PRO Renewal Design

**Date:** 2026-07-14
**Status:** Approved design; awaiting written-spec review

## Goal

Fix two production support issues without changing the legacy editor or the payment backend:

1. Karaoke/highlight subtitles must show the complete editable text while preview playback is paused and must preserve punctuation during playback/rendering.
2. A user whose current plan is PRO but who has no active Stripe subscription must be able to buy or renew PRO from the Pricing page.

## Scope

### Included

- Shared subtitle rendering used by editor previews and Remotion output.
- Pricing-page classification and CTA rendering for trial, granted, one-time, and subscription-backed PRO accounts.
- Regression verification for both behaviors.

### Excluded

- Legacy editor v1 navigation. The missing HERO/back control is accepted because v1 is being retired.
- Stripe checkout authorization rules. The existing backend already permits active-trial conversion and same-tier renewal for accounts without an active subscription.
- Database migrations or new entitlement/provenance fields.
- Changes to trial duration, plan duration, prices, payment methods, or billing-portal behavior.

## Current Evidence

### Subtitle issue

- The affected job stored `ประมาณ 170, 000 บาท` intact, so generation and persistence did not lose the number.
- The editor passed `frame = -1` while paused, with a comment saying this means show the full text.
- Karaoke/highlight token selection did not special-case negative frames. It selected the first token, while Karaoke rendered later tokens using `${color}60`, making `170` and `000` look absent.
- Tokenization kept only `Intl.Segmenter` entries where `isWordLike` is true. Separators such as commas were discarded instead of rendered verbatim.

### Pricing issue

- A genuine signup trial has `plan = PRO` and a future `trialEndsAt`. The current UI deliberately treats that PRO card as purchasable, and the backend allows conversion to PRO or BUSINESS.
- Ratchada's account is different: PRO came from a temporary coupon grant, `trialEndsAt` is null, `subStatus` is not active, and access expires on 2026-07-22.
- The Pricing page marks every non-trial same-tier card as current and disables its CTA, even though `checkoutAllowed()` permits same-tier renewal when there is no active subscription.

## Design

### 1. Subtitle static-preview behavior

The shared renderer will treat a negative frame as a static editing state for both Karaoke and Highlight:

- Render the exact original caption text.
- Use the normal readable base style rather than choosing an active token.
- Do not dim later tokens.
- Keep preset containers such as `box`, `box-rounded`, and `karaoke-box` intact.

This behavior applies to both v1 and v2 preview consumers automatically because they share the renderer. It does not change the frame-by-frame exported animation, where `frame >= 0`.

### 2. Subtitle playback punctuation fidelity

Playback tokenization will distinguish between:

- **Word tokens**, which participate in active-token progress; and
- **Separator tokens**, including spaces, commas, punctuation, currency signs, and percent signs, which are rendered verbatim but do not consume an active-word index.

The concatenated rendered text must equal the original caption text exactly. Examples that must survive unchanged include:

- `ประมาณ 170,000 บาท`
- `ลด 50%`
- `ราคา ฿599`
- Thai text without spaces
- Manual line breaks

Karaoke and Highlight keep their existing active-word colors, timing, and preset containers.

### 3. Pricing purchase-state decision

The Pricing page will base the current-plan CTA on both plan equality and subscription state:

- **Active signup trial:** PRO remains purchasable and shows `สมัคร PRO เลย`.
- **Current paid tier with `subStatus === "active"`:** same-tier card remains non-purchasable and shows `แผนปัจจุบัน`; plan changes continue through Billing to prevent duplicate subscriptions.
- **Current PRO without an active subscription:** PRO is purchasable and shows `ซื้อ / ต่ออายุ PRO`. This covers coupon grants, manual grants, and one-time terms.
- **Non-current higher tier:** existing upgrade behavior remains unchanged.
- **Lower tier:** existing downgrade lock remains unchanged.

The frontend decision will be expressed as a small pure helper so the page and verification script use the same classification. The existing checkout API remains the enforcement layer.

### 4. Payment flow after clicking

The current `handleUpgrade()` flow remains unchanged:

- Monthly forces card payment.
- Annual supports card subscription or one-time PromptPay.
- Successful purchase converts/extends access using the existing webhook logic.
- Active Stripe subscribers cannot create another subscription through checkout.

## Error Handling and Safety

- A pricing-page fetch failure must keep CTAs in their loading state as it does today; it must not assume that an account is renewable.
- The CTA decision must never use only `plan === PRO` as proof of an active paid subscription.
- The backend checkout guard remains authoritative if UI state is stale.
- Subtitle rendering must fall back to exact source text when word segmentation is unavailable or produces no word tokens.

## Verification

### Subtitle regression checks

- Paused Karaoke renders all of `ประมาณ 170,000 บาท` at readable opacity.
- Paused Highlight renders the full original text without choosing an active word.
- Playback Karaoke and Highlight retain commas, `%`, `฿`, spaces, and line breaks.
- Active-word animation still advances across word tokens.
- Existing non-token effects and locked presets are unchanged.

### Pricing regression checks

- Active signup-trial PRO can buy PRO and BUSINESS.
- Coupon/granted PRO with no active subscription can buy/renew PRO.
- One-time PRO with no active subscription can renew PRO.
- Active subscription PRO cannot create a duplicate PRO subscription and is routed to Billing for plan changes.
- BUSINESS-to-PRO downgrade remains blocked.
- Existing `verify-plan-change` checks remain green.

## Rollout and Support

- Deploy the two fixes together only after focused verification and the normal production build.
- Keep Thitima's ticket open until a numeric/punctuation caption is checked in preview and exported output.
- Ratchada can be told that signup trials were already purchasable; the fix specifically adds renewal for temporary/granted PRO accounts like hers.
- Do not change or close the legacy-editor navigation ticket as part of this work.
