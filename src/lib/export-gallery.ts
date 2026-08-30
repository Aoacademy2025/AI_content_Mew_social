import type { Video, VideoStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type ExportGalleryVideoInput = {
  userId: string;
  parentVideoJobId?: string;
  projectId: string | null;
  contentId: string | null;
  avatarModel: string;
  voiceModel: string;
  imageModel: string | null;
  sceneCount: number;
  script: string | null;
  sceneMapping: string | null;
  videoUrl: string | null;
  audioUrl: string | null;
  avatarVideoUrl: string | null;
  renderConfig: string | null;
  status: VideoStatus;
  expiresAt: Date;
};

export type ExportGalleryVideoResult = {
  video: Video;
  created: boolean;
};

/**
 * Persist one Gallery row and, for an Editor export, checkpoint its id on the
 * parent VideoJob in the same transaction. A retry after a worker/web restart
 * returns that checkpointed row instead of creating a duplicate.
 */
export async function persistExportGalleryVideo(
  input: ExportGalleryVideoInput,
): Promise<ExportGalleryVideoResult> {
  return prisma.$transaction(async (tx) => {
    const parent = input.parentVideoJobId
      ? await tx.videoJob.findFirst({
          where: {
            id: input.parentVideoJobId,
            userId: input.userId,
            type: "export",
            status: { in: ["processing", "done"] },
          },
          select: { id: true, projectId: true, videoId: true },
        })
      : null;

    if (input.parentVideoJobId && !parent) {
      throw new Error("export_video_job_not_found");
    }
    if (parent && parent.projectId !== input.projectId) {
      throw new Error("export_project_mismatch");
    }
    if (parent?.videoId) {
      const existing = await tx.video.findFirst({
        where: { id: parent.videoId, userId: input.userId },
      });
      if (!existing) throw new Error("export_gallery_checkpoint_missing");
      return { video: existing, created: false };
    }

    const created = await tx.video.create({
      data: {
        contentId: input.contentId,
        projectId: input.projectId,
        avatarModel: input.avatarModel,
        voiceModel: input.voiceModel,
        imageModel: input.imageModel,
        sceneCount: input.sceneCount,
        script: input.script,
        sceneMapping: input.sceneMapping,
        videoUrl: input.videoUrl,
        audioUrl: input.audioUrl,
        avatarVideoUrl: input.avatarVideoUrl,
        renderConfig: input.renderConfig,
        status: input.status,
        userId: input.userId,
        expiresAt: input.expiresAt,
      },
    });

    let video = created;
    let wonCheckpoint = true;
    if (parent) {
      const checkpoint = await tx.videoJob.updateMany({
        where: {
          id: parent.id,
          userId: input.userId,
          type: "export",
          status: { in: ["processing", "done"] },
          videoId: null,
        },
        data: { videoId: created.id },
      });
      wonCheckpoint = checkpoint.count === 1;
      if (!wonCheckpoint) {
        const winner = await tx.videoJob.findUnique({
          where: { id: parent.id },
          select: { videoId: true },
        });
        const existing = winner?.videoId
          ? await tx.video.findFirst({ where: { id: winner.videoId, userId: input.userId } })
          : null;
        if (!existing) throw new Error("export_gallery_checkpoint_race");
        await tx.video.delete({ where: { id: created.id } });
        video = existing;
      }
    }

    if (input.projectId) {
      await tx.editorProject.updateMany({
        where: { id: input.projectId, userId: input.userId },
        data: {
          latestVideoId: video.id,
          status: video.status === "COMPLETED" ? "exported" : "post",
          lastOpenedAt: new Date(),
        },
      });
    }

    return { video, created: wonCheckpoint };
  });
}
