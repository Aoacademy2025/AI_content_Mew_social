# Campaign: 2026-07-06 v1.2.0 Cold Audience

## Objective

Create a cold-audience promotional Facebook post for the `Hero AI` page using a ChatGPT image-generated graphic and a first-comment CTA.

## Final Assets

- Raw generated source: `public/marketing/2026-07-06-v1-2-0/cold-audience-imagegen2-2x3-raw.png`
- Final feed asset: `public/marketing/2026-07-06-v1-2-0/cold-audience-imagegen2-fb-ig-4x5-blur.png`

Final feed asset specs:

- Size: `1080x1350`
- Aspect ratio: `4:5`
- Method: generated `2:3` source fitted into a `4:5` blurred side canvas
- No manual Thai text overlay

## Image Copy

The Thai text was generated natively inside the image:

```text
HERO AI Creator Studio
มีแค่สคริปต์
ก็ได้คลิปพร้อมโพสต์
AI ช่วยตัดต่อ ใส่ซับ หา B-roll ให้
เริ่มใช้ฟรี 7 วัน
```

## Caption

```text
มีแค่สคริปต์ ก็เริ่มทำคลิปพร้อมโพสต์ได้เร็วขึ้น

HERO AI Creator Studio ช่วยจัดโครงคลิป ตัดต่อ ใส่ซับ และหา B-roll ให้เหมาะกับคอนเทนต์ของคุณ

เหมาะกับครีเอเตอร์ โค้ช เจ้าของธุรกิจ และทีมคอนเทนต์ที่อยากทำวิดีโอให้สม่ำเสมอขึ้น โดยไม่ต้องเริ่มจากศูนย์ทุกครั้ง

ดูรายละเอียดและลิงก์เข้าใช้งานได้ที่คอมเมนต์แรก
```

## First Comment

```text
เริ่มใช้งาน HERO AI Creator Studio ได้ที่นี่:
https://studio.heroaiengine.com/

ทดลองใช้ฟรี 7 วัน ใช้ช่วยทำคอนเทนต์วิดีโอจากสคริปต์ ตัดต่อ ใส่ซับ หา B-roll และจัด workflow การทำคลิปให้เร็วขึ้น
```

## FeedHive Result

- FeedHive post id: `9d1daed7-355c-4bc4-a8ef-e3c7051c9f54`
- Target page: `Hero AI`
- Target platform: Facebook
- Target social id at publish time: `b92cf060-f0ca-4b0e-80ae-56e9a438bb02`
- Created at: `2026-07-06T10:47:20.186Z`
- Main post published at: `2026-07-06T10:48:49.613Z`
- First comment/subpost published at: `2026-07-06T10:48:57.886Z`

No FeedHive API key or signed media URL is stored in this document.

## Notes For Future Agents

- Reconfirm the `Hero AI` social id with `GET /socials` before posting.
- FeedHive API requires a future `scheduled_at` when creating a scheduled post. For "post now", set it 60-120 seconds in the future and poll until `published`.
- FeedHive REST did not return a public Facebook URL in the post response.
