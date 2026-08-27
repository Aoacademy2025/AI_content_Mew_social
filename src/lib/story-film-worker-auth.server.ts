import "server-only";

import { timingSafeStrEqual } from "@/lib/timing-safe-equal";

export function isStoryFilmWorkerAuthorized(request: Request): boolean {
  const secret = process.env.STORY_FILM_WORKER_TOKEN?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  return Boolean(secret && secret.length >= 32 && timingSafeStrEqual(authorization, `Bearer ${secret}`));
}
