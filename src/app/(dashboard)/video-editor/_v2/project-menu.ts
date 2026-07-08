export type ProjectStatusFilter = "all" | "draft" | "working" | "finished";

export type ProjectMenuItem = {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  lastOpenedAt?: string | null;
  createdAt?: string;
};

export const PROJECT_STATUS_FILTER_LABEL: Record<ProjectStatusFilter, string> = {
  all: "ทั้งหมด",
  draft: "ฉบับร่าง",
  working: "กำลังทำงาน",
  finished: "พร้อมแก้ต่อ",
};

export function projectStatusLabel(status: string) {
  if (status === "draft") return "ฉบับร่าง";
  if (status === "rendering") return "กำลังเรนเดอร์";
  if (status === "post") return "แต่งต่อ";
  if (status === "exporting") return "กำลังส่งออก";
  if (status === "exported") return "ส่งออกแล้ว";
  return status;
}

export function projectDeleteBlocked(status: string) {
  return status === "rendering" || status === "exporting";
}

export function filterProjectMenuItems<T extends ProjectMenuItem>(
  projects: T[],
  filter: ProjectStatusFilter,
): T[] {
  if (filter === "all") return projects;
  if (filter === "draft") return projects.filter((p) => p.status === "draft");
  if (filter === "working") return projects.filter((p) => p.status === "rendering" || p.status === "exporting");
  return projects.filter((p) => p.status === "post" || p.status === "exported");
}
