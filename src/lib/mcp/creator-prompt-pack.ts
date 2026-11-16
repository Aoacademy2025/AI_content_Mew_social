import type { ActiveStylePackId } from "@/lib/style-pack-catalog";

export const MCP_ENDPOINT_URL = "https://studio.heroaiengine.com/api/mcp";
export const MCP_UPGRADE_URL = "https://studio.heroaiengine.com/pricing";
export const MCP_TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";

export type McpCreatorPromptTemplate = {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  templateId: ActiveStylePackId;
  prompt: string;
};

export const MCP_CREATOR_PROMPT_TEMPLATES: readonly McpCreatorPromptTemplate[] = [
  {
    id: "news-fast-1",
    title: "สรุปข่าวด่วน 45 วิ (News Fast)",
    subtitle: "เหมาะกับข่าวเทคโนโลยี เศรษฐกิจ หรืออัปเดตเทรนด์รายวัน",
    category: "ข่าวไว",
    templateId: "news-fast",
    prompt:
      "สร้างคลิปสั้นจากหัวข้อข่าวนี้ด้วย create_video_job โดยใช้ templateId: \"news-fast\", brollSource: \"stock\", ความยาวประมาณ 45 วินาที พร้อมพาดหัวเปิดคลิปสั้นกระชับ: \"<วางหัวข้อข่าวหรือเนื้อหาสรุปของคุณที่นี่>\"",
  },
  {
    id: "shop-review-1",
    title: "รีวิวสินค้าป้ายยา (Shop Review)",
    subtitle: "เน้นจุดเด่นสินค้า 3 ข้อ ปิดการขายไวสำหรับ TikTok / Reels",
    category: "ป้ายยา",
    templateId: "shop-review",
    prompt:
      "สร้างคลิปรีวิวสินค้าด้วย create_video_job โดยใช้ templateId: \"shop-review\", brollSource: \"stock\", ความยาวประมาณ 45 วินาที เน้นจุดเด่น 3 ข้อและ Call-to-Action ท้ายคลิป: \"<วางชื่อสินค้าและจุดเด่นที่นี่>\"",
  },
  {
    id: "listicle-fast-1",
    title: "จัดอันดับ 3 เทคนิค (Listicle Fast)",
    subtitle: "เล่าเป็นข้อ 1-2-3 กระชับ เข้าใจง่าย คนดูจนจบ",
    category: "จัดอันดับ",
    templateId: "listicle-fast",
    prompt:
      "สร้างคลิปจัดอันดับ 3 เทคนิคด้วย create_video_job โดยใช้ templateId: \"listicle-fast\", brollSource: \"stock\", ความยาวประมาณ 60 วินาที แบ่งเป็นข้อ 1, 2, 3 ชัดเจน: \"<วางหัวข้อ 3 เทคนิคของคุณที่นี่>\"",
  },
  {
    id: "finance-clear-1",
    title: "สรุปการเงิน/การลงทุน (Finance Clear)",
    subtitle: "อธิบายเรื่องเงิน ภาษี หรือการลงทุนให้เข้าใจง่ายใน 1 นาที",
    category: "การเงิน",
    templateId: "finance-clear",
    prompt:
      "สร้างคลิปความรู้การเงินด้วย create_video_job โดยใช้ templateId: \"finance-clear\", brollSource: \"stock\", ความยาวประมาณ 60 วินาที น้ำเสียงน่าเชื่อถือและเข้าใจง่าย: \"<วางประเด็นการเงินหรือการลงทุนที่นี่>\"",
  },
  {
    id: "thai-ghost-1",
    title: "เรื่องเล่าลึกลับ/เรื่องหลอน (Thai Ghost)",
    subtitle: "โทนดาร์ก บรรยากาศลุ้นระทึก ดึงคนฟังตั้งแต่วินาทีแรก",
    category: "เรื่องหลอน",
    templateId: "thai-ghost",
    prompt:
      "สร้างคลิปเล่าเรื่องลึกลับด้วย create_video_job โดยใช้ templateId: \"thai-ghost\", brollSource: \"stock\", ความยาวประมาณ 60 วินาที เปิดด้วยประโยคชวนสงสัย: \"<วางโครงเรื่องลึกลับของคุณที่นี่>\"",
  },
];

export function buildClaudeDesktopConfigJson(token: string = MCP_TOKEN_PLACEHOLDER): string {
  return JSON.stringify(
    {
      mcpServers: {
        heroai: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            MCP_ENDPOINT_URL,
            "--header",
            `Authorization: Bearer ${token}`,
          ],
        },
      },
    },
    null,
    2,
  );
}

export function buildCursorMcpConfigJson(token: string = MCP_TOKEN_PLACEHOLDER): string {
  return JSON.stringify(
    {
      mcpServers: {
        heroai: {
          url: MCP_ENDPOINT_URL,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  );
}

export function buildClaudeCodeCommand(token: string = MCP_TOKEN_PLACEHOLDER): string {
  return `claude mcp add --transport http heroai ${MCP_ENDPOINT_URL} \\
  --header "Authorization: Bearer ${token}"`;
}
