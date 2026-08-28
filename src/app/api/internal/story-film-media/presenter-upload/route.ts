import { NextResponse } from "next/server";
import {
  claimStoryFilmPresenterUploadGrant,
  completeStoryFilmPresenterUploadGrant,
} from "@/lib/story-film-presenter-upload-grant.server";
import {
  StoryFilmPresenterUploadError,
  uploadStoryFilmPresenter,
} from "@/lib/story-film-presenter-upload.server";
import { StoryFilmError } from "@/lib/story-film.server";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const grant = await claimStoryFilmPresenterUploadGrant(request);
    if (!grant) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const asset = await uploadStoryFilmPresenter(request, grant.userId, {
      originalName: grant.originalName,
      mimeType: grant.mimeType,
      sizeBytes: grant.sizeBytes,
    });
    await completeStoryFilmPresenterUploadGrant(grant.id, asset.id);
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    if (error instanceof StoryFilmPresenterUploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof StoryFilmError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
    }
    console.error("[story-film/internal-upload-presenter] failed", error);
    return NextResponse.json({ error: "อัปโหลด Presenter ไม่สำเร็จ กรุณาลองใหม่" }, { status: 500 });
  }
}
