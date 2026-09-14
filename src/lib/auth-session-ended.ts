"use client";

let ended = false;

export function isAuthSessionEnded(): boolean {
  return ended;
}

export function markAuthSessionEnded(): void {
  ended = true;
}

export function clearAuthSessionEnded(): void {
  ended = false;
}
