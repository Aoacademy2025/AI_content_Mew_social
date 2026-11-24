import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";
import { THAI_LOANWORDS } from "@/lib/thai-loanwords";
import { THAI_COMPOUNDS } from "@/lib/thai-compounds";
import { loadThaiDict } from "@/lib/loanword-mining";
import {
  buildDictStraddleIndex,
  COMPOUND_REVIEW_JSON_SCHEMA,
  reviewCompoundsWithLlm,
  type DictStraddleIndex,
} from "@/lib/compound-review";
import { getServerGeminiKey } from "@/lib/server-keys";
import { geminiGenerateText } from "@/lib/gemini";
import {
  readLoanwordStore,
  writeLoanwordStore,
  refreshDynamicLoanwords,
  denyWord,
  restoreWord,
  addWord,
  editWord,
  addCompound,
  approveCompound,
  rejectCompound,
  bulkApproveCompounds,
  bulkRejectCompounds,
  applyCompoundReview,
  type LoanwordStore,
} from "@/lib/thai-loanwords-runtime";

export const runtime = "nodejs";

let _cachedStraddleIndex: DictStraddleIndex | null | undefined;
function getDictStraddleIndex(): DictStraddleIndex | null {
  if (_cachedStraddleIndex !== undefined) return _cachedStraddleIndex;
  try {
    const dictPath = path.join(process.cwd(), "data/words_th.txt");
    if (!fs.existsSync(dictPath)) {
      _cachedStraddleIndex = null;
      return null;
    }
    const dict = loadThaiDict(fs.readFileSync(dictPath, "utf8"));
    _cachedStraddleIndex = buildDictStraddleIndex(dict);
    return _cachedStraddleIndex;
  } catch (e) {
    console.warn("[admin/loanwords] failed to load Thai dict for straddle guard:", e);
    _cachedStraddleIndex = null;
    return null;
  }
}

async function requireAdmin() {
  const authUser = await getCurrentUser();
  if (!authUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (authUser.role !== "ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { authUser };
}

function serializeAdminResponse(s: LoanwordStore, hasGeminiKey: boolean) {
  return {
    words: s.words,
    denylist: s.denylist,
    lastAdded: s.lastAdded ?? [],
    lastRunAt: s.lastRunAt ?? null,
    seed: THAI_LOANWORDS,
    seedCount: THAI_LOANWORDS.length,
    pendingCompounds: s.pendingCompounds ?? [],
    compounds: s.compounds ?? [],
    autoApprovedCompounds: s.autoApprovedCompounds ?? [],
    lastCompoundsFound: s.lastCompoundsFound ?? [],
    lastCompoundRunAt: s.lastCompoundRunAt ?? null,
    lastCompoundReviewAt: s.lastCompoundReviewAt ?? null,
    lastCompoundReviewSummary: s.lastCompoundReviewSummary ?? null,
    compoundReviewLog: s.compoundReviewLog ?? [],
    compoundSeed: THAI_COMPOUNDS,
    compoundSeedCount: THAI_COMPOUNDS.length,
    hasGeminiKey,
  };
}

export async function GET() {
  try {
    const { error } = await requireAdmin();
    if (error) return error;
    const [s, serverKey] = await Promise.all([readLoanwordStore(), getServerGeminiKey()]);
    return NextResponse.json(serializeAdminResponse(s, Boolean(serverKey)));
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
    const wordsList = Array.isArray(body?.words)
      ? body.words.filter((w: unknown): w is string => typeof w === "string" && w.trim().length > 0).map((w: string) => w.trim())
      : [];

    const s = await readLoanwordStore();

    if (action === "aiReviewPending") {
      const targets = wordsList.length > 0 ? wordsList : (s.pendingCompounds ?? []);
      if (targets.length === 0) {
        const serverKey = await getServerGeminiKey();
        return NextResponse.json({
          ok: true,
          summary: { approved: 0, rejected: 0, keptForReview: 0, source: "admin" },
          reviewed: [],
          ...serializeAdminResponse(s, Boolean(serverKey)),
        });
      }
      const serverKey = await getServerGeminiKey();
      const straddleIndex = getDictStraddleIndex();
      const reviewed = await reviewCompoundsWithLlm(targets, {
        straddleIndex,
        batchSize: 35,
        callLlm: serverKey
          ? (prompt) => geminiGenerateText(serverKey, prompt, 4096, 0, {
              responseMimeType: "application/json",
              responseJsonSchema: COMPOUND_REVIEW_JSON_SCHEMA,
            })
          : null,
      });
      const { store: next, summary } = applyCompoundReview(s, reviewed, { source: "admin" });
      await writeLoanwordStore(next);
      await refreshDynamicLoanwords();
      return NextResponse.json({
        ok: true,
        summary,
        reviewed,
        usedAi: Boolean(serverKey),
        ...serializeAdminResponse(next, Boolean(serverKey)),
      });
    }

    if (action === "bulkApproveCompounds") {
      if (wordsList.length === 0) return NextResponse.json({ error: "words required" }, { status: 400 });
      const next = bulkApproveCompounds(s, wordsList);
      await writeLoanwordStore(next);
      await refreshDynamicLoanwords();
      return NextResponse.json({ ok: true, words: next.words, denylist: next.denylist, compounds: next.compounds ?? [], pendingCompounds: next.pendingCompounds ?? [] });
    }

    if (action === "bulkRejectCompounds") {
      if (wordsList.length === 0) return NextResponse.json({ error: "words required" }, { status: 400 });
      const next = bulkRejectCompounds(s, wordsList);
      await writeLoanwordStore(next);
      await refreshDynamicLoanwords();
      return NextResponse.json({ ok: true, words: next.words, denylist: next.denylist, compounds: next.compounds ?? [], pendingCompounds: next.pendingCompounds ?? [] });
    }

    if (!word) return NextResponse.json({ error: "word required" }, { status: 400 });

    let next: LoanwordStore;
    switch (action) {
      case "deny":    next = denyWord(s, word); break;
      case "restore": next = restoreWord(s, word); break;
      case "add":     next = addWord(s, word); break;
      case "addCompound": next = addCompound(s, word); break;
      case "edit":
        if (!newWord) return NextResponse.json({ error: "newWord required for edit" }, { status: 400 });
        next = editWord(s, word, newWord);
        break;
      case "approveCompound": next = approveCompound(s, word); break;
      case "rejectCompound":  next = rejectCompound(s, word); break;
      default:
        return NextResponse.json({ error: "invalid action" }, { status: 400 });
    }
    await writeLoanwordStore(next);
    await refreshDynamicLoanwords(); // make the change live in this process immediately (not just the 10-min tick)
    return NextResponse.json({ ok: true, words: next.words, denylist: next.denylist, compounds: next.compounds ?? [], pendingCompounds: next.pendingCompounds ?? [] });
  } catch (error) { return apiError({ route: "POST /api/admin/loanwords", error }); }
}
