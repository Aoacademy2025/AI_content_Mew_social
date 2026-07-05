import type { ComponentType } from "react";

export interface DocMeta {
  slug: string;      // → /docs/<slug>
  title: string;
  category: string;  // จัดกลุ่มใน sidebar
  order: number;     // ลำดับรวม (เรียงทั้งชุด)
  keywords: string[];// ใช้ค้นหา
  summary: string;   // snippet ในผลค้นหา + การ์ดหน้าโฮม
}

export interface DocEntry {
  meta: DocMeta;
  Component: ComponentType;
}
