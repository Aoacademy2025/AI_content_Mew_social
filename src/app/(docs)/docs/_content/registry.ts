import type { DocEntry, DocMeta } from "./types";
import * as gettingStarted from "./getting-started";

// เพิ่มหัวข้อใหม่ = import ที่นี่ แล้วใส่ใน modules[]
const modules = [
  gettingStarted,
];

export const docs: DocEntry[] = modules
  .map((m) => ({ meta: m.meta as DocMeta, Component: m.default }))
  .sort((a, b) => a.meta.order - b.meta.order);

export function getDoc(slug: string): DocEntry | undefined {
  return docs.find((d) => d.meta.slug === slug);
}

export interface DocCategory { name: string; items: DocMeta[]; }

export const docsByCategory: DocCategory[] = (() => {
  const order: string[] = [];
  const map = new Map<string, DocMeta[]>();
  for (const d of docs) {
    if (!map.has(d.meta.category)) { map.set(d.meta.category, []); order.push(d.meta.category); }
    map.get(d.meta.category)!.push(d.meta);
  }
  return order.map((name) => ({ name, items: map.get(name)! }));
})();

export const searchIndex: DocMeta[] = docs.map((d) => d.meta);
