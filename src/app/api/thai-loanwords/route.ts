import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { THAI_LOANWORDS } from "@/lib/thai-loanwords";
import { readLoanwordStore } from "@/lib/thai-loanwords-runtime";

// 5-min server cache so editor mounts don't hammer the DB.
let cache: { at: number; data: { words: string[]; denylist: string[] } } | null = null;
const TTL = 5 * 60 * 1000;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const now = Date.now();
  if (cache && now - cache.at < TTL) return NextResponse.json(cache.data);
  const store = await readLoanwordStore();
  const deny = new Set(store.denylist);
  const words = [...new Set([...THAI_LOANWORDS, ...store.words])].filter((w) => !deny.has(w));
  const data = { words, denylist: store.denylist };
  cache = { at: now, data };
  return NextResponse.json(data);
}
