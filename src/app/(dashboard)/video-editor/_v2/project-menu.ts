export type ProjectStatusFilter = "all" | "draft" | "working" | "finished";

export type ProjectMenuItem = {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  lastOpenedAt?: string | null;
  createdAt?: string;
};

export const PROJECT_MENU_LIMIT = 8;

export type ProjectMenuSnapshot = {
  projects: ProjectMenuItem[];
  total: number;
};

export async function fetchRecentProjectMenu(
  fetcher: typeof fetch = fetch,
  limit = PROJECT_MENU_LIMIT,
): Promise<ProjectMenuSnapshot> {
  const response = await fetcher("/api/editor-projects", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("โหลดรายการโปรเจกต์ไม่สำเร็จ กรุณาลองใหม่");
  }
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload?.projects)) {
    throw new Error("โหลดรายการโปรเจกต์ไม่สำเร็จ กรุณาลองใหม่");
  }
  const allProjects = payload.projects as ProjectMenuItem[];
  return {
    projects: allProjects.slice(0, Math.max(0, limit)),
    total: allProjects.length,
  };
}

export function projectMenuDate(project: ProjectMenuItem, locale = "th-TH"): string | null {
  const value = project.lastOpenedAt || project.updatedAt || project.createdAt;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

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
