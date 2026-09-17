import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type HeroScriptLibraryStatus = "all" | "draft" | "sent";

export interface HeroScriptLibraryQuery {
  q: string;
  status: HeroScriptLibraryStatus;
  /** null means every brand; "none" means scripts without a brand. */
  brandProfileId: string | "none" | null;
  page: number;
  pageSize: number;
}

export interface HeroScriptLibraryItem {
  id: string;
  topic: string;
  brandProfileId: string | null;
  brandName: string | null;
  durationSec: number;
  status: string;
  editorProjectId: string | null;
  editorProjectAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface HeroScriptLibraryBrandOption {
  id: string;
  name: string;
}

export interface HeroScriptLibraryPage {
  items: HeroScriptLibraryItem[];
  brandOptions: HeroScriptLibraryBrandOption[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export type HeroScriptLibraryQueryResult =
  | { ok: true; query: HeroScriptLibraryQuery }
  | { ok: false; error: string };

function positiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseHeroScriptLibraryQuery(params: URLSearchParams): HeroScriptLibraryQueryResult {
  for (const key of ["q", "status", "brandProfileId", "page", "pageSize"]) {
    if (params.getAll(key).length > 1) return { ok: false, error: "พารามิเตอร์ซ้ำกัน" };
  }
  const q = (params.get("q") ?? "").trim();
  if (q.length > 200) return { ok: false, error: "คำค้นหายาวเกิน 200 ตัวอักษร" };

  const status = params.get("status") ?? "all";
  if (status !== "all" && status !== "draft" && status !== "sent") {
    return { ok: false, error: "สถานะไม่ถูกต้อง" };
  }

  const rawBrandProfileId = params.get("brandProfileId");
  if (rawBrandProfileId !== null && (rawBrandProfileId.length === 0 || rawBrandProfileId.length > 200)) {
    return { ok: false, error: "โปรไฟล์แบรนด์ไม่ถูกต้อง" };
  }
  const brandProfileId = rawBrandProfileId === null
    ? null
    : rawBrandProfileId === "none"
      ? "none"
      : rawBrandProfileId;

  const page = positiveInteger(params.get("page"), 1);
  const pageSize = positiveInteger(params.get("pageSize"), 20);
  if (page === null || pageSize === null || pageSize > 20) {
    return { ok: false, error: "หน้าหรือจำนวนรายการต่อหน้าไม่ถูกต้อง" };
  }
  if ((page - 1) * pageSize > 2_147_483_647) {
    return { ok: false, error: "หน้าที่ขอมีค่ามากเกินไป" };
  }

  return { ok: true, query: { q, status, brandProfileId, page, pageSize } };
}

export async function listHeroScriptLibrary(
  userId: string,
  query: HeroScriptLibraryQuery,
): Promise<HeroScriptLibraryPage> {
  const where: Prisma.ScriptWhereInput = {
    userId,
    ...(query.q ? { topic: { contains: query.q } } : {}),
    ...(query.status === "all" ? {} : { status: query.status }),
    ...(query.brandProfileId === "none"
      ? { brandProfileId: null }
      : query.brandProfileId
        ? { brandProfile: { is: { id: query.brandProfileId, userId } } }
        : {
            OR: [
              { brandProfileId: null },
              { brandProfile: { is: { userId } } },
            ],
          }),
  };
  const skip = (query.page - 1) * query.pageSize;
  const [total, rows, brandOptions] = await prisma.$transaction([
    prisma.script.count({ where }),
    prisma.script.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip,
      take: query.pageSize,
      select: {
        id: true,
        topic: true,
        brandProfileId: true,
        brandProfile: { select: { name: true } },
        durationSec: true,
        status: true,
        editorProjectId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.brandProfile.findMany({
      where: {
        userId,
        scripts: { some: { userId } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    }),
  ]);
  const projectIds = [...new Set(rows.flatMap((row) => row.editorProjectId ? [row.editorProjectId] : []))];
  const ownedProjects = projectIds.length === 0
    ? []
    : await prisma.editorProject.findMany({
        where: { userId, id: { in: projectIds } },
        select: { id: true },
      });
  const ownedProjectIds = new Set(ownedProjects.map((project) => project.id));

  return {
    items: rows.map((row) => {
      const editorProjectAvailable = !!row.editorProjectId && ownedProjectIds.has(row.editorProjectId);
      return {
        id: row.id,
        topic: row.topic,
        brandProfileId: row.brandProfileId,
        brandName: row.brandProfile?.name ?? null,
        durationSec: row.durationSec,
        status: row.status,
        editorProjectId: editorProjectAvailable ? row.editorProjectId : null,
        editorProjectAvailable,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }),
    brandOptions,
    total,
    page: query.page,
    pageSize: query.pageSize,
    hasNextPage: skip + rows.length < total,
  };
}
