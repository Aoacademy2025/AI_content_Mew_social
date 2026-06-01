# Support Ticket → n8n

เว็บจะยิง POST ไปที่ n8n webhook ทุกครั้งที่ user กด **"ส่งคำร้อง"** ใน Support modal.

## 1. ตั้งค่าฝั่งเว็บ (VPS `.env`)

```env
# ถ้าเว้นว่าง จะ fallback ไปใช้ N8N_WEBHOOK_URL
N8N_SUPPORT_WEBHOOK_URL="https://<your-n8n-host>/webhook/Contactus"
```

ยิงแบบ **fire-and-forget** — ไม่บล็อก user. ถ้า n8n ล่ม user ยังส่ง ticket ได้ปกติ (DB + email ผ่าน Gmail/Resend ยังทำงาน) แค่ไม่เข้า n8n.

> หมายเหตุ: เว็บ**ส่ง email อยู่แล้ว** (Gmail API → Resend fallback) ไปยัง `SUPPORT_EMAIL`.
> n8n เป็น**ช่องทางเสริม** — ถ้าจะให้ n8n เป็นตัวส่ง email หลัก ให้เคลียร์ `SUPPORT_EMAIL`
> ในเว็บเพื่อกัน email ซ้ำ (เว็บจะข้ามการส่ง email เองเมื่อไม่มี `SUPPORT_EMAIL`).

## 2. Payload ที่เว็บส่งไป n8n

```json
{
  "event": "support_ticket_created",
  "ticketId": "clxxxxxxxxxxxxx",
  "ticketShort": "a1b2c3",
  "createdAt": "2026-06-01T10:30:00.000Z",
  "user": {
    "id": "clxxxx",
    "name": "ผู้ใช้งาน",
    "email": "user@mail.com",
    "plan": "FREE",
    "isPaid": false
  },
  "message": "อธิบายปัญหา...",
  "supportEmails": ["info.aoacademy@gmail.com"],
  "attachment": {
    "name": "screenshot.png",
    "contentType": "image/png",
    "dataUrl": "data:image/png;base64,iVBOR..."
  }
}
```

`attachment` เป็น `null` ถ้า user ไม่ได้แนบรูป. `supportEmails` คือค่าจาก **Support Email** setting (Admin → Settings) เผื่อให้ n8n route/CC ไปที่อีเมลทีมงานชุดเดียวกัน.

## 3. Workflow (`support-ticket-workflow.json`)

Import ไฟล์นี้เข้า n8n แล้วผูก Gmail credential (แทนที่ `REPLACE_WITH_GMAIL_CRED_ID` ทั้ง 3 node หรือเลือก credential จาก UI).

```
Webhook (POST /Contactus)
   ├─→ Respond 200            (ตอบกลับเว็บทันที — ไม่ให้รอ email)
   └─→ Priority?  (user.isPaid)
          ├─ true  → Email Team (Priority)  ─┐
          └─ false → Email Team (Normal)    ─┴─→ Email User (Acknowledge)
```

## 4. อีเมลที่ส่ง — ส่งอะไร / ส่งเมื่อไหร่ / ส่งหาใคร

| # | อีเมล | ส่งเมื่อไหร่ | ส่งหาใคร | เนื้อหา |
|---|-------|-------------|----------|---------|
| 1 | **Email Team (Priority)** | ทันทีที่ ticket เข้า **และ** user เป็น Pro/Business (`isPaid = true`) | `supportEmails` (ทีมงาน) | หัวข้อมี `[PLAN]` นำหน้า, ข้อมูล user + ข้อความ + รูปแนบ, `Reply-To = user email` |
| 2 | **Email Team (Normal)** | ทันทีที่ ticket เข้า **และ** user เป็น Free | `supportEmails` (ทีมงาน) | เหมือนข้อ 1 แต่ไม่มี tag priority |
| 3 | **Email User (Acknowledge)** | ทันทีหลังส่งเมลแจ้งทีมงานเสร็จ | **user** (`user.email`) | "เราได้รับคำร้องแล้ว จะติดต่อกลับใน 24 ชม." + สำเนาข้อความที่เขาส่ง |

ทั้งหมดเกิดขึ้น **เรียลไทม์** ตอน user กดส่ง (ไม่มี delay/schedule). Email ทีมงานตั้ง **Reply-To = user email** ดังนั้นทีมงานกด Reply ในกล่องเมลได้เลย ข้อความจะวิ่งไปหา user ตรงๆ.

> **เรื่องรูปแนบ:** node Gmail ใช้ field `attachment` แบบ binary. n8n เวอร์ชันใหม่อ่าน base64 `dataUrl`
> ใน JSON body ตรงๆ เป็น binary ไม่ได้ ต้องมี **Convert to File / Extract from File** node คั่นก่อน
> (อ่าน `body.attachment.dataUrl` → แปลงเป็น binary ชื่อ `attachment`). ถ้ายังไม่ทำขั้นนี้
> เมลทีมงานจะส่งได้ปกติแต่**ไม่มีไฟล์แนบ** — รูปยังดูได้เสมอผ่าน Admin Panel (เก็บใน DB).

## 5. การตอบกลับ user

ตอบได้ 2 ทาง:
- **Reply อีเมล** ที่ทีมงานได้รับ (Reply-To ตั้งไว้แล้ว) — ตรงถึง user
- **Admin Panel** (`/admin?tab=support`) — กดตอบในระบบ เว็บจะส่ง reply email + in-app notification ให้ user เอง (มีอยู่แล้ว ไม่เกี่ยวกับ n8n)
