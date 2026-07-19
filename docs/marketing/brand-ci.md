# HERO AI Brand CI

Use this guide for generated graphics, infographics, static ads, and product update visuals.

## Brand

- Brand name: `HERO AI Creator Studio`
- Product URL: `https://studio.heroaiengine.com/`
- Positioning: Thai-first AI video creation SaaS for creators, coaches, educators, business owners, and content teams.
- Core promise: turn a script or idea into a video workflow faster, with editing, subtitles, B-roll, and creator-studio tooling.

## Visual Identity

- Overall mood: premium dark SaaS, polished, useful, modern, creator-studio focused.
- Avoid: log-style screenshots, generic corporate blue, beige/brown/orange palettes, noisy fake UI text, placeholder text, and stock-photo-looking layouts.
- Logo source: `public/logo.svg`
- Logo mark: rounded violet square with white `H` shape.

## Colors

Use these as the main brand palette:

- App background: `#06060B`, `#0A0A10`, `#0F0F17`
- Panel/background surfaces: `#101018`, `#0C0C13`
- Primary gradient: `#8B66F8` to `#6C4CF4`
- Primary violet: `#8B5CF6`
- Highlight violet: `#B9A6FF`
- Link violet: `#9B7DFF`
- Main text: `#F2F2F8`, `#F4F5FF`
- Muted text: `#9C9CB4`, `#A7ADCC`
- Subtitle/accent yellow: `#FFE500` or `#FBBF24`
- Success accent: `#34D399`

## Typography

Use clean Thai sans-serif styling:

- Product/landing page references: `Bai Jamjuree`, `IBM Plex Sans Thai`
- Editor UI references: `Kanit`, `Noto Sans Thai`
- Image prompts should say: bold clean Thai sans serif, high contrast, readable on mobile feed.

## Copy Style

Thai copy should be human-facing marketing copy, not release notes or logs.

Prefer:

- Direct benefit first.
- Short lines.
- Cold audience clarity.
- CTA that tells the user where to act.

Avoid:

- Markdown headings in user-facing graphics.
- Developer terms unless the audience already knows them.
- Long feature dumps.
- Text that sounds like an internal changelog.

## Image Generation Rule

When Mew asks for imagegen content:

- The generated image must include both visual design and Thai text natively from ChatGPT image generation.
- Do not manually add Thai text overlays after generation unless Mew explicitly approves that exception.
- Local post-processing is allowed only for image resizing, padding, compression, or blurred canvas fill.
- If adapting `2:3` source to `4:5`, do not crop important content. Use blurred side canvas from the same image.

## Standard Social Sizes

- Facebook/Instagram feed final: `1080x1350` (`4:5`)
- Preferred generated source when text-heavy: `2:3` vertical source, centered safe margins.
- Final conversion: fit the full `2:3` image into `4:5` with blurred side fill.

## Default CTA Pattern

For cold audience static ads:

- Main visual CTA can be short: `เริ่มใช้ฟรี 7 วัน`
- Post caption CTA: `ดูรายละเอียดได้ที่คอมเมนต์แรก`
- First comment should include the product URL: `https://studio.heroaiengine.com/`
