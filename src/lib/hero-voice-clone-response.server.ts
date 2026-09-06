export const HERO_VOICE_CLONE_PRIVATE_CACHE_CONTROL = "private, no-store";

export function heroVoiceClonePrivateResponse<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", HERO_VOICE_CLONE_PRIVATE_CACHE_CONTROL);
  return response;
}

export function heroVoiceClonePrivateJson(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", HERO_VOICE_CLONE_PRIVATE_CACHE_CONTROL);
  return Response.json(body, { ...init, headers });
}
