# Support Ticket → n8n

> ⚠️ **DEPRECATED (2026-06-20).** เว็บ**เลิกยิง n8n แล้ว** — อีเมล ticket ทั้งหมด
> (แจ้งทีม + ack user) ส่งจากเว็บเองผ่าน **Resend** (`src/lib/send-email.ts`:
> `sendSupportTicketEmail` + `sendSupportAckEmail`, เรียกใน `src/app/api/support/route.ts`).
> เหตุผล: n8n ฟรีบน Render + Gmail OAuth (สถานะ Testing) refresh token หมดอายุทุก 7 วัน
> = "เคยส่งได้ อยู่ ๆ ไม่ส่ง". เอกสารด้านล่างเก็บไว้อ้างอิงประวัติเท่านั้น.

เว็บจะยิง POST ไปที่ n8n webhook ทุกครั้งที่ user กด **"ส่งคำร้อง"** ใน Support modal.

## 1. ตั้งค่าฝั่งเว็บ (VPS `.env`)

```env
# ถ้าเว้นว่าง จะ fallback ไปใช้ N8N_WEBHOOK_URL
N8N_SUPPORT_WEBHOOK_URL="https://<your-n8n-host>/webhook/Contactus"
```

ยิงแบบ **fire-and-forget** — ไม่บล็อก user.

> **n8n เป็นเจ้าของอีเมลทั้งหมด** (เมลแจ้งทีมงาน + เมล ack user). เว็บ**ไม่ส่งอีเมลเอง**แล้ว
> เพื่อกันอีเมลซ้ำ — เว็บแค่บันทึก ticket ลง DB, แจ้ง admin ใน app (กระดิ่ง), แล้วยิง payload ไป n8n.
> ถ้า n8n ล่ม: ticket ยังเข้า DB + admin เห็นในกระดิ่ง แต่**อีเมลจะไม่ออก** — ต้องดู ticket
> ผ่าน Admin Panel แทน.
>
> ปลายทางอีเมลทีมงาน (`supportEmails` ใน payload) มาจาก **Admin → Settings → Support Email**
> (เก็บใน DB) ถ้าไม่ได้ตั้งจะ fallback ไป env `SUPPORT_EMAIL`.

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

Import ไฟล์นี้เข้า n8n แล้วผูก Gmail credential (ทุก Gmail node ตั้ง id `OVuTDXJsRYkGhSCM` ไว้ — ถ้า credential คนละตัว ให้เลือกใหม่จาก dropdown ใน UI ของแต่ละ node).

```
Webhook (POST /Contactus)
   ├─→ Respond 200            (ตอบกลับเว็บทันที — ไม่ให้รอ email)
   └─→ มีรูปแนบ?  (body.attachment exists)
          ├─ true  → base64 → File → Email Team (มีรูป)   ─┐
          └─ false → Email Team (ไม่มีรูป)                  ─┴─→ Email User (Acknowledge)
```

**จุดสำคัญ:** node `base64 → File` (Convert to File) แปลง `body.attachment.dataUrl` เป็น binary
ชื่อ `attachment` ก่อนเข้า Gmail — แก้ error *"expects binary file 'attachment', but none was found"*.
ส่วนเคสไม่มีรูป จะไปที่ Gmail node ที่**ไม่ตั้ง attachment** จึงไม่ error.
Priority (Pro/Business) จัดการในตัว Gmail node เลย — เติม `[PLAN]` + `⚡ PRIORITY` ในหัวข้อ/เนื้อหา
อัตโนมัติด้วยเงื่อนไข `user.isPaid` (ไม่ต้องแยก node).

## 4. อีเมลที่ส่ง — ส่งอะไร / ส่งเมื่อไหร่ / ส่งหาใคร

| # | อีเมล | ส่งเมื่อไหร่ | ส่งหาใคร | เนื้อหา |
|---|-------|-------------|----------|---------|
| 1 | **Email Team (มีรูป)** | ทันทีที่ ticket เข้า **และมี**รูปแนบ | `supportEmails` (ทีมงาน) | ข้อมูล user + ข้อความ + **ไฟล์แนบ**, `Reply-To = user email`, เติม `[PLAN] ⚡ PRIORITY` ถ้า user จ่ายเงิน |
| 2 | **Email Team (ไม่มีรูป)** | ทันทีที่ ticket เข้า **และไม่มี**รูปแนบ | `supportEmails` (ทีมงาน) | เหมือนข้อ 1 แต่ไม่มีไฟล์แนบ |
| 3 | **Email User (Acknowledge)** | ทันทีหลังส่งเมลแจ้งทีมงานเสร็จ | **user** (`user.email`) | "เราได้รับคำร้องแล้ว จะติดต่อกลับใน 24 ชม." + สำเนาข้อความที่เขาส่ง |

ทั้งหมดเกิดขึ้น **เรียลไทม์** ตอน user กดส่ง (ไม่มี delay/schedule). Email ทีมงานตั้ง **Reply-To = user email** ดังนั้นทีมงานกด Reply ในกล่องเมลได้เลย ข้อความจะวิ่งไปหา user ตรงๆ.

## 5. การตอบกลับ user

ตอบได้ 2 ทาง:
- **Reply อีเมล** ที่ทีมงานได้รับ (Reply-To ตั้งไว้แล้ว) — ตรงถึง user
- **Admin Panel** (`/admin?tab=support`) — กดตอบในระบบ เว็บจะส่ง reply email + in-app notification ให้ user เอง (มีอยู่แล้ว ไม่เกี่ยวกับ n8n)
