import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireHeroScriptUser } from "@/lib/hero-script.server";
import {
  listHeroScriptLibrary,
  parseHeroScriptLibraryQuery,
} from "@/lib/hero-script-library.server";

// GET /api/scripts/library — bounded summaries across the caller's full library.
export async function GET(req: Request) {
  try {
    const access = await requireHeroScriptUser();
    if (!access.ok) return access.response;

    const parsed = parseHeroScriptLibraryQuery(new URL(req.url).searchParams);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    return NextResponse.json(await listHeroScriptLibrary(access.user.id, parsed.query));
  } catch (error) {
    return apiError({ route: "GET /api/scripts/library", error });
  }
}
