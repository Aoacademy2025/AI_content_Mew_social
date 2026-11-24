export const MCP_UPGRADE_URL = "https://studio.heroaiengine.com/pricing";
export const MCP_PLAN_REQUIRED_SOURCE = "mcp_plan_required";

export const MCP_PRO_UPGRADE_OFFER =
  "อัปเกรดเป็น PRO เพื่อปลดล็อก MCP เต็มรูปแบบ (สร้างคลิปไม่จำกัดสิทธิ์ทดลอง 1 คลิป, แก้ไข/batch edit, Hero AI Image, Hero Script และอัปโหลดสื่อ) — รองรับทั้งรายเดือน บัตรเครดิต และ PromptPay (Upgrade to PRO/BUSINESS for unlimited MCP creation, editing, Hero AI Image, Hero Script, and uploads).";

export function sanitizeMcpToolParam(toolName?: string | null): string | null {
  if (typeof toolName !== "string") return null;
  const cleaned = toolName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return cleaned ? cleaned.slice(0, 64) : null;
}

export function buildMcpPlanRequiredUpgradeUrl(toolName?: string | null): string {
  const params = new URLSearchParams({ source: MCP_PLAN_REQUIRED_SOURCE });
  const safeTool = sanitizeMcpToolParam(toolName);
  if (safeTool) params.set("tool", safeTool);
  return `${MCP_UPGRADE_URL}?${params.toString()}`;
}

export function buildMcpUpgradeNext(upgradeUrl: string): string {
  return `ส่งลิงก์ ${upgradeUrl} ให้ผู้ใช้อัปเกรดเป็นแผน PRO หรือ BUSINESS (Upgrade to PRO/BUSINESS at ${upgradeUrl}) แล้วลองเรียกคำสั่งนี้ใหม่`;
}

export type McpPlanRequiredPayload = {
  error: "plan_required";
  code: "plan_required";
  message: string;
  next: string;
  upgradeUrl: string;
  upgradeOffer: string;
};

export function buildMcpPlanRequiredPayload(input: {
  toolName?: string | null;
  message?: string;
  next?: string;
} = {}): McpPlanRequiredPayload {
  const upgradeUrl = buildMcpPlanRequiredUpgradeUrl(input.toolName);
  const message =
    input.message ??
    `ฟีเจอร์ MCP นี้ใช้ได้เฉพาะแผน PRO หรือ BUSINESS — แผนปัจจุบันยังเข้าถึงไม่ได้ อัปเกรดที่ ${upgradeUrl}`;
  const next = input.next ?? buildMcpUpgradeNext(upgradeUrl);
  return {
    error: "plan_required",
    code: "plan_required",
    message,
    next,
    upgradeUrl,
    upgradeOffer: MCP_PRO_UPGRADE_OFFER,
  };
}
