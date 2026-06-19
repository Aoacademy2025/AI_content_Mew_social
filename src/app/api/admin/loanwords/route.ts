import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { THAI_LOANWORDS } from "@/lib/thai-loanwords";
import {
  readLoanwordStore,
  writeLoanwordStore,
  refreshDynamicLoanwords,
  denyWord,
  restoreWord,
  addWord,
  editWord,
} from "@/lib/thai-loanwords-runtime";

export const runtime = "nodejs";

async function requireAdmin() {
  const authUser = await getCurrentUser();
  if (!authUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (authUser.role !== "ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { authUser };
}

export async function GET() {
  try {
    const { error } = await requireAdmin();
    if (error) return error;
    const s = await readLoanwordStore();
    return NextResponse.json({
      words: s.words,            // auto-mined + manually added (editable here)
      denylist: s.denylist,
      lastAdded: s.lastAdded ?? [],
      seed: THAI_LOANWORDS,      // static, in-code — read-only in the UI
      seedCount: THAI_LOANWORDS.length,
    });
  } catch (error) { return apiError({ route: "GET /api/admin/loanwords", error }); }
}

export async function POST(req: Request) {
  try {
    const { error } = await requireAdmin();
    if (error) return error;
    const body = await req.json().catch(() => null);
    const action = body?.action;
    const word = typeof body?.word === "string" ? body.word.trim() : "";
    const newWord = typeof body?.newWord === "string" ? body.newWord.trim() : "";
    if (!word) return NextResponse.json({ error: "word required" }, { status: 400 });

    const s = await readLoanwordStore();
    let next;
    switch (action) {
      case "deny":    next = denyWord(s, word); break;
      case "restore": next = restoreWord(s, word); break;
      case "add":     next = addWord(s, word); break;
      case "edit":
        if (!newWord) return NextResponse.json({ error: "newWord required for edit" }, { status: 400 });
        next = editWord(s, word, newWord);
        break;
      default:
        return NextResponse.json({ error: "action must be deny|restore|add|edit" }, { status: 400 });
    }
    await writeLoanwordStore(next);
    await refreshDynamicLoanwords(); // make the change live in this process immediately (not just the 10-min tick)
    return NextResponse.json({ ok: true, words: next.words, denylist: next.denylist });
  } catch (error) { return apiError({ route: "POST /api/admin/loanwords", error }); }
}
