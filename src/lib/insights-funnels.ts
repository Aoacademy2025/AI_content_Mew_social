function pct(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

// Creation funnel from VideoJob (server truth) — the real path every generation
// walks, regardless of editor version. progress is server-written + monotonic;
// milestones match orchestrator step() calls.
export type JobFunnelRow = { userId: string; status: string; progress: number };

const JOB_FUNNEL_STEPS = [
  { key: "created", label: "เริ่มสร้าง (สั่งเรนเดอร์)", reached: (_j: JobFunnelRow) => true },
  { key: "broll", label: "ได้ B-roll", reached: (j: JobFunnelRow) => j.progress >= 55 },
  { key: "config", label: "จัดคลิปเสร็จ", reached: (j: JobFunnelRow) => j.progress >= 65 },
  { key: "render", label: "เรนเดอร์", reached: (j: JobFunnelRow) => j.progress >= 75 },
  { key: "done", label: "เสร็จสมบูรณ์", reached: (j: JobFunnelRow) => j.status === "done" },
] as const;

export function summarizeJobFunnel(jobs: JobFunnelRow[]) {
  const funnel = JOB_FUNNEL_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    count: jobs.filter(s.reached).length,
    conversionPct: 0,
    dropOffPct: 0,
    previousCount: 0,
  })).map((step, i, all) => {
    const previousCount = i === 0 ? step.count : all[i - 1].count;
    const conversionPct = i === 0 ? 100 : Math.min(100, pct(step.count, previousCount));
    return { ...step, previousCount, conversionPct, dropOffPct: i === 0 ? 0 : Math.max(0, 100 - conversionPct) };
  });
  return { funnel, funnelMode: "job" as const, funnelRuns: funnel[0]?.count ?? 0 };
}

// Activation funnel counts (signups -> opened -> started -> first video ->
// repeat), with @aoacademy internal accounts excluded.
export function computeActivationFunnel(input: {
  users: Array<{ id: string; email: string | null; createdAt: Date }>;
  openedUserIds: Array<string | null>;
  jobUserIds: string[];
  completedByUser: Array<{ userId: string; count: number }>;
  since: Date;
}) {
  const internalIds = new Set(
    input.users.filter((u) => (u.email ?? "").toLowerCase().includes("@aoacademy")).map((u) => u.id),
  );
  const notInternal = (id: string) => !internalIds.has(id);
  // MCP/chat users create jobs without opening the web editor, so fold job
  // creators into engaged users to keep openedEditor >= startedPipeline.
  const engagedIds = new Set<string>();
  for (const id of input.openedUserIds) if (id) engagedIds.add(id);
  for (const id of input.jobUserIds) engagedIds.add(id);
  return {
    internalTeam: internalIds.size,
    signups: input.users.length - internalIds.size,
    openedEditor: Array.from(engagedIds).filter(notInternal).length,
    startedPipeline: input.jobUserIds.filter(notInternal).length,
    completedFirstVideo: input.completedByUser.filter((g) => notInternal(g.userId)).length,
    repeatCreators: input.completedByUser.filter((g) => notInternal(g.userId) && g.count >= 2).length,
    windowSignups: input.users.filter((u) => u.createdAt >= input.since && notInternal(u.id)).length,
  };
}
