"use client";

import { Section, ApiRow } from "../_components/ui";
import { useDocsContext } from "../_components/docs-context";

/** โหมด BYOK เดิม (legacy): แสดงเฉพาะเมื่อระบบยังไม่ได้จัดการ Gemini ให้ (managed=false) */
export function SetupApiKeysGeminiNote() {
  const { managed } = useDocsContext();
  if (managed) return null;

  return (
    <Section title="ใส่ Gemini key เอง">
      <ApiRow
        name="Gemini API Key"
        required
        desc="ใส่ key ของตัวเอง (โหมด BYOK)"
        link="https://aistudio.google.com/apikey"
      />
    </Section>
  );
}
