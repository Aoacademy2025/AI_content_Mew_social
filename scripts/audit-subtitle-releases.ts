import { prisma } from "../src/lib/prisma";
import { auditSubtitleReleaseRecord } from "../src/lib/subtitle-release-audit";

function numericArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const days = Math.min(90, numericArg("days", 7));
  const since = new Date(Date.now() - days * 24 * 60 * 60_000);
  const rows = await prisma.videoJob.findMany({
    where: { status: "done", createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, type: true, inputJson: true, outputJson: true },
  });
  const issues = rows.flatMap(auditSubtitleReleaseRecord);
  const counts = issues.reduce<Record<string, number>>((summary, issue) => {
    summary[issue.code] = (summary[issue.code] ?? 0) + 1;
    return summary;
  }, {});
  const affectedJobs = new Set(issues.map((issue) => issue.jobId));
  const result = {
    since: since.toISOString(),
    scannedJobs: rows.length,
    affectedJobs: affectedJobs.size,
    p0: issues.filter((issue) => issue.severity === "p0").length,
    p1: issues.filter((issue) => issue.severity === "p1").length,
    counts,
    // Job IDs + issue codes are sufficient for operations follow-up; scripts,
    // captions, account emails and media URLs never leave the database here.
    issues,
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes("--fail-on-p0") && result.p0 > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
