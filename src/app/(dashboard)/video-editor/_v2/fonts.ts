import { Kanit, Noto_Sans_Thai } from "next/font/google";

/**
 * v2 fonts (Design System v1.1): Kanit = หัวข้อ/ปุ่ม/ตัวเลขเด่น · Noto Sans Thai = เนื้อหา UI
 * Scoped to the v2 root via CSS variables — legacy editor typography untouched.
 */

export const kanit = Kanit({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-kanit",
  display: "swap",
});

export const notoSansThai = Noto_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600"],
  variable: "--font-noto-thai",
  display: "swap",
});

/** ใส่ที่ root ของ v2 เพื่อให้ token font.heading/font.body resolve ได้ */
export const v2FontClass = `${kanit.variable} ${notoSansThai.variable}`;
