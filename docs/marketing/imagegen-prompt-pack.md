# Imagegen Prompt Pack

Use the built-in `image_gen` tool by default. Read the `imagegen` skill before generating images.

## Non-Negotiables

- Thai text must be generated inside the image by ChatGPT image generation.
- Do not manually overlay Thai copy after image generation.
- For final `4:5`, it is acceptable to create a blurred side canvas from the generated image without adding text.
- Save final project-bound assets under `public/marketing/<yyyy-mm-dd-campaign-slug>/`.
- Always keep the raw generated source and the final social-size version.

## Cold Audience Static Ad, 2:3 Source

Use this prompt as the baseline. Adjust only campaign-specific copy.

```text
Use case: ads-marketing
Asset type: Source creative for Facebook / Instagram feed static ad. Generate as a clean 2:3 vertical poster composition. It will later be placed onto a 4:5 canvas with blurred side fill, so keep all important text and visuals centered with generous safe margins.

Primary request: Create one finished promotional ad creative for a cold audience. The image itself must include both the visual design and all Thai copy, generated natively inside the image. Do not leave blank space for later text overlay.

Brand: HERO AI Creator Studio, premium AI video creation SaaS.

Audience: Thai creators, coaches, educators, and business owners who have ideas/scripts but do not want to spend hours editing videos.

Visual concept: A sleek dark creator-studio workspace with a vertical video preview, AI editing timeline, subtitle blocks, B-roll suggestion cards, and a polished purple AI glow. Premium, modern, useful, approachable.

Style/medium: high-end SaaS marketing static ad, sharp UI mockup elements, clean social media layout, professional Thai ad design.

Composition/framing: 2:3 vertical source poster. Strong hierarchy: small brand label at top, large Thai headline centered, supporting line below, polished product/UI visual around it, CTA button near lower area. Keep safe margins on all sides. Do not crop text.

Color palette: HERO AI dark background #06060B / #101018, violet gradient #8B66F8 to #6C4CF4, off-white text #F4F5FF, muted lavender #A7ADCC, small yellow subtitle accent #FFE500. Avoid beige, brown, orange, and generic blue corporate gradients.

Text (verbatim, render this Thai text accurately inside the image):
"HERO AI Creator Studio"
"มีแค่สคริปต์"
"ก็ได้คลิปพร้อมโพสต์"
"AI ช่วยตัดต่อ ใส่ซับ หา B-roll ให้"
"เริ่มใช้ฟรี 7 วัน"

Typography: bold clean Thai sans serif, high contrast, readable at mobile feed size. Thai spelling must be exact. No markdown, no hashtags, no extra log-style text.

Constraints: The generated image must already contain the Thai text as part of the image. No placeholder text. No manual text overlay expected later. No watermark. No fake UI gibberish competing with the main Thai copy. Keep the layout uncluttered and premium.
```

## Product Update Infographic Prompt

```text
Use case: ads-marketing
Asset type: 2:3 source poster for a Facebook / Instagram product update post. The final will be placed on a 4:5 blurred side canvas.

Primary request: Create a polished HERO AI Creator Studio product update graphic for Thai users. The image must include the visual design and all Thai copy natively inside the image.

Audience: Existing users and warm audience who want to know what improved.

Visual concept: premium dark SaaS update card showing a modern creator studio, multiple project thumbnails, mobile editor preview, subtitle timeline, and B-roll picker. It should feel like a user-friendly product announcement, not a developer changelog.

Text (verbatim, render Thai accurately):
"HERO AI Creator Studio"
"อัปเดตใหม่"
"ทำหลายโปรเจกต์ได้แล้ว"
"Editor ใช้ง่ายขึ้นบนมือถือ"
"Preview คมขึ้น + B-roll ไทยตรงขึ้น"

Color palette: #06060B, #101018, #8B66F8, #6C4CF4, #F4F5FF, #A7ADCC, #FFE500.

Constraints: No markdown. No log-style bullet list. No placeholder text. No manual text overlay expected later. Keep all important text centered with safe margins.
```

## Local 2:3 to 4:5 Conversion

Use this only after the image has already been generated with text inside it. This does not add text.

```bash
node -e 'const sharp=require("sharp"); const input="<raw-2x3.png>"; const output="<final-4x5.png>"; (async()=>{ const W=1080,H=1350; const bg=await sharp(input).resize(W,H,{fit:"cover",position:"center"}).blur(32).modulate({brightness:0.5,saturation:1.08}).png().toBuffer(); const fg=await sharp(input).resize(W,H,{fit:"contain",background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer(); await sharp(bg).composite([{input:fg,left:0,top:0}]).png({compressionLevel:9}).toFile(output); const meta=await sharp(output).metadata(); console.log(`${output} ${meta.width}x${meta.height}`); })().catch((err)=>{ console.error(err); process.exit(1); });'
```

Validation:

- Final must be `1080x1350`.
- No Thai text layer was added locally.
- No important text is cropped.
- Open with `view_image` before publishing.
