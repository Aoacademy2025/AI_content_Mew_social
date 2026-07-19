# Content Marketing SOP

This SOP lets a fresh Codex agent create, QA, and publish HERO AI social content without relying on prior chat context.

## Required Inputs

Before starting, collect or infer:

- Campaign objective: cold audience promo, product update, feature announcement, tutorial, or retargeting.
- Target channel: Facebook page, Instagram feed, or both.
- Posting mode: publish now or schedule.
- CTA destination: default `https://studio.heroaiengine.com/`.
- Any approved copy or feature points from Mew.

If the user says "โพสเลย", publish as soon as possible.

## Source Files To Read

Read these before generating:

- `docs/marketing/brand-ci.md`
- `docs/marketing/imagegen-prompt-pack.md`
- Current campaign doc under `docs/marketing/campaigns/` if one exists.
- `public/logo.svg` for the logo/mark reference.

## Workflow

1. Define the content angle.

   For cold audience, lead with the pain and outcome:
   - Has only a script or idea.
   - Wants a ready-to-post video.
   - Does not want to spend hours editing.
   - HERO AI helps with editing, subtitles, B-roll, and workflow.

2. Draft the image prompt.

   Use `docs/marketing/imagegen-prompt-pack.md`.
   The prompt must say that Thai text is rendered natively inside the image.
   Do not plan manual Thai text overlay.

3. Generate the image.

   Use the built-in `image_gen` tool by default.
   For feed posts with Thai text, prefer a `2:3` vertical poster source with safe margins.

4. Save generated assets into the project.

   Folder pattern:

   ```text
   public/marketing/<yyyy-mm-dd-campaign-slug>/
   ```

   Filename pattern:

   ```text
   <campaign>-imagegen2-2x3-raw.png
   <campaign>-fb-ig-4x5-blur.png
   ```

5. Convert to social size.

   Create final `1080x1350` `4:5` with blurred side canvas from the same image.
   Do not crop the source.
   Do not overlay Thai text.

6. QA the graphic.

   Required checks:
   - `view_image` the final file.
   - Confirm Thai text is readable.
   - Confirm text is not cropped.
   - Confirm it follows HERO AI dark/violet CI.
   - Confirm final size is `1080x1350`.
   - If running a dev server, check the local URL with `curl -I`.

7. Draft caption and first comment.

   Default main post caption for cold audience:

   ```text
   มีแค่สคริปต์ ก็เริ่มทำคลิปพร้อมโพสต์ได้เร็วขึ้น

   HERO AI Creator Studio ช่วยจัดโครงคลิป ตัดต่อ ใส่ซับ และหา B-roll ให้เหมาะกับคอนเทนต์ของคุณ

   เหมาะกับครีเอเตอร์ โค้ช เจ้าของธุรกิจ และทีมคอนเทนต์ที่อยากทำวิดีโอให้สม่ำเสมอขึ้น โดยไม่ต้องเริ่มจากศูนย์ทุกครั้ง

   ดูรายละเอียดและลิงก์เข้าใช้งานได้ที่คอมเมนต์แรก
   ```

   Default first comment:

   ```text
   เริ่มใช้งาน HERO AI Creator Studio ได้ที่นี่:
   https://studio.heroaiengine.com/

   ทดลองใช้ฟรี 7 วัน ใช้ช่วยทำคอนเทนต์วิดีโอจากสคริปต์ ตัดต่อ ใส่ซับ หา B-roll และจัด workflow การทำคลิปให้เร็วขึ้น
   ```

8. Publish through FeedHive.

   Use the FeedHive REST API. Never save the API key in repo files.

   Set token only in a temporary shell variable:

   ```bash
   FH_KEY='<provided-by-user-or-env>'
   ```

   Verify token:

   ```bash
   curl -sS -H "Authorization: Bearer $FH_KEY" -H 'accept: application/json' https://api.feedhive.com/status
   ```

   Find the HERO AI social account:

   ```bash
   curl -sS -H "Authorization: Bearer $FH_KEY" -H 'accept: application/json' https://api.feedhive.com/socials
   ```

   Known `Hero AI` Facebook social id from 2026-07-06:

   ```text
   b92cf060-f0ca-4b0e-80ae-56e9a438bb02
   ```

   Reconfirm this id with `/socials` each session before posting.

9. Upload media to FeedHive.

   Flow:
   - `POST https://api.feedhive.com/media/uploads`
   - `PUT` the image bytes to the returned `upload_url` with the same `Content-Type`
   - `POST https://api.feedhive.com/media/uploads/:id/complete`
   - Use returned `data.id` as the media id in `POST /posts`

10. Create the post.

   FeedHive requires `scheduled_at` to be a future datetime when `status` is `scheduled`.
   If user says publish now, set `scheduled_at` around 60-120 seconds in the future and poll until published.

   Payload shape:

   ```json
   {
     "text": "<main caption>",
     "media": ["<feedhive-media-id>"],
     "subposts": [
       {
         "text": "<first comment text>",
         "media": []
       }
     ],
     "accounts": ["<hero-ai-social-id>"],
     "status": "scheduled",
     "scheduled_at": "<future ISO datetime>",
     "publish_type": "regular",
     "short_link_enabled": false,
     "notes": "Created by Codex marketing workflow."
   }
   ```

11. Verify publication.

   Poll:

   ```bash
   curl -sS -H "Authorization: Bearer $FH_KEY" -H 'accept: application/json' "https://api.feedhive.com/posts/<post-id>"
   ```

   Success criteria:
   - `status` becomes `published`.
   - `published_at` is set.
   - First comment/subpost has `published_at`.

   Note: FeedHive REST API may not return a public Facebook post URL.

## Security Rules

- Do not commit FeedHive API keys.
- Do not include full bearer token in logs or docs.
- Do not commit signed S3 upload/download URLs.
- Do not store OTPs, session cookies, or production credentials.

## Definition Of Done

- Final asset exists in `public/marketing/...`.
- Campaign doc is created or updated under `docs/marketing/campaigns/`.
- Graphic QA passed.
- FeedHive API response saved only in `/tmp` if needed.
- Post is `published` or scheduled with exact time reported to Mew.
- No secrets added to repo.
