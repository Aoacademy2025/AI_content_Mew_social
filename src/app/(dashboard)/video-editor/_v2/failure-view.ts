/**
 * Customer-facing failure copy for Editor v2.
 *
 * VideoJob.errorMessage is durable diagnostic evidence. It can contain provider
 * codes, HTTP details, or English intended for support logs, so this module must
 * never echo it to a customer. Classification may inspect exact, reviewed legacy
 * markers, but every visible sentence is owned here.
 */

export type FailureKind =
  | "heygen-quota"
  | "provider-key"
  | "provider-quota"
  | "content-preflight"
  | "hero-image-transient"
  | "insufficient-credits"
  | "rate-limited"
  | "generic";

export interface FailureJobLike {
  errorCode: string | null;
  errorMessage: string | null;
  errorProvider: string | null;
  currentStep?: string | null;
}

const HEYGEN_CREDIT_MARKER = /MOVIO_PAYMENT_INSUFFICIENT_CREDIT|INSUFFICIENT_CREDIT|Insufficient credit[^.]*api[^.]*credit|เครดิต HeyGen ไม่เพียงพอ/i;
const INSUFFICIENT_CREDITS_TEXT_MARKER = /เครดิตไม่พอสำหรับ Hero AI Image/;
const HERO_IMAGE_TRANSIENT_CODES = new Set([
  "HERO_IMAGE_OUTPUT_FAILED",
  "HERO_IMAGE_TIMEOUT",
  "HERO_IMAGE_UNAVAILABLE",
  "HERO_IMAGE_FAILED",
  "HERO_IMAGE_ASSET_UNAVAILABLE",
]);

export function classifyFailure(job: FailureJobLike): FailureKind {
  if (
    job.errorProvider === "heygen"
    && (job.errorCode === "quota" || HEYGEN_CREDIT_MARKER.test(job.errorMessage ?? ""))
  ) return "heygen-quota";
  if (job.errorCode === "invalid_key") return "provider-key";
  if (job.errorCode === "quota") return "provider-quota";
  if (job.errorCode?.startsWith("CONTENT_PREFLIGHT_")) return "content-preflight";
  if (HERO_IMAGE_TRANSIENT_CODES.has(job.errorCode ?? "")) return "hero-image-transient";
  if (
    job.errorCode === "INSUFFICIENT_CREDITS"
    || INSUFFICIENT_CREDITS_TEXT_MARKER.test(job.errorMessage ?? "")
  ) return "insufficient-credits";
  if (job.errorCode === "RATE_LIMITED") return "rate-limited";
  return "generic";
}

export interface FailureViewCopy {
  heading: string;
  body: string;
}

function providerName(provider: string | null): string {
  if (provider === "heygen") return "HeyGen";
  if (provider === "elevenlabs") return "ElevenLabs";
  if (provider === "omnivoice") return "Hero AI Voice";
  if (provider === "gemini") return "Gemini";
  return "ผู้ให้บริการที่เชื่อมต่อ";
}

function genericStepCopy(step: string | null | undefined, exportMode: boolean): FailureViewCopy {
  switch (step) {
    case "tts":
      return {
        heading: "สร้างเสียงพากย์ไม่สำเร็จ",
        body: "ระบบยังสร้างเสียงรอบนี้ไม่สำเร็จ — ลองใหม่อีกครั้ง หากใช้ API Key ส่วนตัว ให้ตรวจสอบ Key และโควต้าใน Settings",
      };
    case "captions":
      return {
        heading: "สร้างคำบรรยายไม่สำเร็จ",
        body: "ระบบยังจัดเวลาคำบรรยายรอบนี้ไม่สำเร็จ ข้อมูลโปรเจกต์ยังอยู่ — กลับไปลองเรนเดอร์ใหม่ได้",
      };
    case "keywords":
    case "stock":
      return {
        heading: "เตรียมภาพประกอบไม่สำเร็จ",
        body: "ระบบยังเตรียมภาพประกอบไม่ครบในรอบนี้ — กลับไปลองเรนเดอร์ใหม่ได้",
      };
    case "render":
      return {
        heading: "ประกอบวิดีโอไม่สำเร็จ",
        body: "ภาพ เสียง และการตั้งค่าของโปรเจกต์ยังอยู่ — กลับไปลองเรนเดอร์ใหม่ได้",
      };
    case "avatar":
      return {
        heading: "สร้าง Avatar ไม่สำเร็จ",
        body: "ขั้น Avatar ยังไม่สำเร็จ — ตรวจสอบ API Key, เครดิต และ Avatar ในบัญชี HeyGen หรือปิด Avatar แล้วลองใหม่",
      };
    case "composite":
      return {
        heading: "ประกอบ Avatar กับวิดีโอไม่สำเร็จ",
        body: "วิดีโอพื้นหลังยังอยู่ แต่ขั้นประกอบ Avatar ยังไม่สำเร็จ — กลับไปลองใหม่ได้",
      };
    case "burn":
    case "save":
      return {
        heading: "ส่งออกวิดีโอไม่สำเร็จ",
        body: "วิดีโอต้นฉบับและคำบรรยายยังอยู่ — กลับไปลองส่งออกใหม่ได้",
      };
    default:
      return {
        heading: exportMode ? "ส่งออกวิดีโอไม่สำเร็จ" : "สร้างวิดีโอไม่สำเร็จ",
        body: exportMode
          ? "โปรเจกต์และวิดีโอต้นฉบับยังอยู่ — กลับไปลองส่งออกใหม่ได้"
          : "โปรเจกต์ยังอยู่ครบ — กลับไปลองเรนเดอร์ใหม่ได้",
      };
  }
}

/** Every returned sentence is reviewed product copy; diagnostic text stays in logs/admin. */
export function failureViewCopy(kind: FailureKind, job: FailureJobLike, exportMode: boolean): FailureViewCopy {
  if (kind === "heygen-quota") {
    return {
      heading: "เครดิต HeyGen ไม่เพียงพอ",
      body: "เครดิต API ของ HeyGen เป็นคนละส่วนกับเครดิต Hero งานนี้หยุดที่ขั้น Avatar และระบบคืนสิทธิ์เรนเดอร์ของ Hero แล้ว — เติมเครดิตในบัญชี HeyGen หรือปิด Avatar แล้วลองใหม่",
    };
  }
  if (kind === "provider-key") {
    const provider = providerName(job.errorProvider);
    return {
      heading: job.errorProvider === "heygen" ? "เชื่อมต่อ HeyGen ไม่สำเร็จ" : "เชื่อมต่อบริการภายนอกไม่สำเร็จ",
      body: `API Key ของ ${provider} ใช้ไม่ได้หรือหมดอายุ — ไปที่ Settings เพื่ออัปเดต Key แล้วลองใหม่`,
    };
  }
  if (kind === "provider-quota") {
    const provider = providerName(job.errorProvider);
    return {
      heading: job.currentStep === "tts" ? "โควต้าเสียงพากย์ไม่เพียงพอ" : `โควต้าของ ${provider} ไม่เพียงพอ`,
      body: `เติมโควต้าในบัญชี ${provider} แล้วลองใหม่ หรือเลือกตัวเลือกอื่นในหน้าตั้งค่า`,
    };
  }
  if (kind === "content-preflight") {
    return {
      heading: "วิเคราะห์แนวภาพไม่สำเร็จ",
      body: "ระบบยังวิเคราะห์แนวภาพจากเนื้อหาของคลิปรอบนี้ไม่สำเร็จ โปรเจกต์และคลิปที่อัปโหลดยังอยู่ — กลับไปลองเรนเดอร์ใหม่ได้",
    };
  }
  if (kind === "hero-image-transient") {
    return {
      heading: "ภาพ AI บางฉากสร้างไม่สำเร็จ",
      body: "ระบบหยุดงานรอบนี้ เครดิตภาพที่ไม่สำเร็จไม่ถูกคิด และเครดิตที่จองไว้ถูกคืนให้แล้ว — กลับไปลองเรนเดอร์ใหม่ได้",
    };
  }
  if (kind === "insufficient-credits") {
    return {
      heading: "เครดิต Hero ไม่พอสำหรับภาพ AI",
      body: "งานนี้ต้องใช้เครดิตมากกว่าที่มี ระบบยังไม่เริ่มสร้างภาพ — เติมเครดิตหรือลดจำนวนภาพแล้วลองใหม่",
    };
  }
  if (kind === "rate-limited") {
    return {
      heading: "สร้างภาพ AI ถี่เกินไปชั่วคราว",
      body: "ระบบพักการสร้างภาพชั่วคราวและยังไม่หักเครดิต — รอสักครู่แล้วลองใหม่",
    };
  }
  return genericStepCopy(job.currentStep, exportMode);
}
