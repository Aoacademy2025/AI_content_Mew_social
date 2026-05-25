import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import type { StepStatus } from "./types";

export function StepIcon({ status }: { status: StepStatus }) {
  if (status === "running") return <Loader2 className="w-3 h-3 animate-spin text-violet-400" />;
  if (status === "done")    return <CheckCircle2 className="w-3 h-3 text-emerald-400" />;
  if (status === "error")   return <AlertCircle className="w-3 h-3 text-red-400" />;
  if (status === "skip")    return <span className="w-3 h-3 text-slate-600 text-[10px]">—</span>;
  return <span className="w-3 h-3 rounded-full border border-slate-700 inline-block" />;
}
