import { prisma } from "./prisma";

/** Safety cap for window ToolCallAudit reads on /admin/insights (retention is 90 days + poll-throttled). */
export const MCP_AUDIT_WINDOW_ROW_CAP = 100_000;

const CONTROL_AND_FORMAT_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const TERMINAL_JOB_STATUSES = new Set(["done", "failed", "canceled"]);

export type McpTopToolRow = {
  toolName: string;
  calls: number;
  customerCalls: number;
  realErrors: number;
  notReadyPolls: number;
  customerUsers: number;
};

export type McpClientFamilyRow = {
  family: string;
  calls: number;
  customerCalls: number;
};

export type InsightsMcpUsage = {
  tokens: {
    active: number;
    customerActive: number;
    total: number;
    customerUsersEverUsed: number;
  };
  calls: {
    total: number;
    customerCalls: number;
    internalCalls: number;
    activeCustomerUsers: number;
    okCalls: number;
    notReadyPolls: number;
    realErrorCalls: number;
    deniedCalls: number;
    realSuccessPct: number | null;
  };
  quoteJobs: {
    total: number;
    done: number;
    failed: number;
    canceled: number;
    inFlight: number;
  };
  topTools: McpTopToolRow[];
  topClients: McpClientFamilyRow[];
};

export type McpUsageUserFact = {
  id: string;
  email: string | null;
  role: string;
};

export type McpUsageTokenRow = {
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
};

export type McpUsageAuditRow = {
  userId: string | null;
  toolName: string;
  status: string;
  responseJson: string | null;
  userAgent: string | null;
};

export type McpUsageQuoteJobRow = {
  userId: string;
  status: string;
};

export function buildInternalOrAdminUserIds(users: ReadonlyArray<McpUsageUserFact>): Set<string> {
  const excluded = new Set<string>();
  for (const user of users) {
    if (user.role === "ADMIN" || (user.email ?? "").toLowerCase().includes("@aoacademy")) {
      excluded.add(user.id);
    }
  }
  return excluded;
}

export function isNotReadyAuditResponse(responseJson: string | null | undefined): boolean {
  if (!responseJson) return false;
  try {
    const parsed = JSON.parse(responseJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const obj = parsed as { code?: unknown; error?: unknown };
    return obj.code === "not_ready" || obj.error === "not_ready";
  } catch {
    return false;
  }
}

export function normalizeMcpClientFamily(userAgent: string | null | undefined): string {
  if (!userAgent) return "Pre-capture / unknown";
  const cleaned = userAgent.replace(CONTROL_AND_FORMAT_CHARS, "").trim();
  if (!cleaned) return "Pre-capture / unknown";

  if (/claude|anthropic/i.test(cleaned)) return "Claude";
  if (/cursor/i.test(cleaned)) return "Cursor";
  if (/codex|openai/i.test(cleaned)) return "Codex";
  if (/windsurf|codeium/i.test(cleaned)) return "Windsurf";
  if (/cline/i.test(cleaned)) return "Cline";
  if (/chatgpt/i.test(cleaned)) return "ChatGPT";
  if (/python|httpx|aiohttp|requests/i.test(cleaned)) return "Python";

  // Never echo accidental emails, URLs, or credential-shaped strings from untrusted User-Agent headers.
  if (cleaned.includes("@") || cleaned.includes("://") || /^(bearer\b|sk-|rk-|mcp_|hero_)/i.test(cleaned)) {
    return "Other / custom";
  }

  const prefix = cleaned
    .split(/[\/\s(;:,]/)[0]
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 24);
  return prefix || "Pre-capture / unknown";
}

function sanitizeToolLabel(toolName: string): string {
  const cleaned = toolName.replace(CONTROL_AND_FORMAT_CHARS, "").trim().slice(0, 64);
  return cleaned || "unknown";
}

export function summarizeInsightsMcpUsage(input: {
  now: Date;
  excludedUserIds: ReadonlySet<string>;
  tokens: ReadonlyArray<McpUsageTokenRow>;
  auditRows: ReadonlyArray<McpUsageAuditRow>;
  quoteJobs: ReadonlyArray<McpUsageQuoteJobRow>;
}): InsightsMcpUsage {
  const { now, excludedUserIds, tokens, auditRows, quoteJobs } = input;
  const nowMs = now.getTime();
  const isInternalOrAdmin = (userId: string | null): boolean =>
    Boolean(userId && excludedUserIds.has(userId));

  let activeTokens = 0;
  let customerActiveTokens = 0;
  const customerTokenUsersEver = new Set<string>();
  for (const token of tokens) {
    const isCustomer = !excludedUserIds.has(token.userId);
    const isActive =
      token.revokedAt === null &&
      (token.expiresAt === null || token.expiresAt.getTime() > nowMs);
    if (isActive) {
      activeTokens += 1;
      if (isCustomer) customerActiveTokens += 1;
    }
    if (isCustomer && token.lastUsedAt !== null) {
      customerTokenUsersEver.add(token.userId);
    }
  }

  let customerCalls = 0;
  let internalCalls = 0;
  let okCalls = 0;
  let notReadyPolls = 0;
  let realErrorCalls = 0;
  let deniedCalls = 0;
  const activeCustomerUsers = new Set<string>();

  const toolAcc = new Map<
    string,
    {
      toolName: string;
      calls: number;
      customerCalls: number;
      realErrors: number;
      notReadyPolls: number;
      customerUserIds: Set<string>;
    }
  >();
  const clientAcc = new Map<string, { family: string; calls: number; customerCalls: number }>();

  for (const row of auditRows) {
    const customerCall = !isInternalOrAdmin(row.userId);
    if (customerCall) {
      customerCalls += 1;
      if (row.userId) activeCustomerUsers.add(row.userId);
    } else {
      internalCalls += 1;
    }

    let isNotReady = false;
    let isRealError = false;
    if (row.status === "ok") {
      okCalls += 1;
    } else if (row.status === "denied") {
      deniedCalls += 1;
    } else if (row.status === "error") {
      if (isNotReadyAuditResponse(row.responseJson)) {
        isNotReady = true;
        notReadyPolls += 1;
      } else {
        isRealError = true;
        realErrorCalls += 1;
      }
    }

    const toolName = sanitizeToolLabel(row.toolName);
    const toolEntry = toolAcc.get(toolName) ?? {
      toolName,
      calls: 0,
      customerCalls: 0,
      realErrors: 0,
      notReadyPolls: 0,
      customerUserIds: new Set<string>(),
    };
    toolEntry.calls += 1;
    if (customerCall) {
      toolEntry.customerCalls += 1;
      if (row.userId) toolEntry.customerUserIds.add(row.userId);
    }
    if (isRealError) toolEntry.realErrors += 1;
    if (isNotReady) toolEntry.notReadyPolls += 1;
    toolAcc.set(toolName, toolEntry);

    const family = normalizeMcpClientFamily(row.userAgent);
    const clientEntry = clientAcc.get(family) ?? { family, calls: 0, customerCalls: 0 };
    clientEntry.calls += 1;
    if (customerCall) clientEntry.customerCalls += 1;
    clientAcc.set(family, clientEntry);
  }

  const settledCalls = okCalls + realErrorCalls;
  const realSuccessPct =
    settledCalls > 0 ? Math.round((okCalls / settledCalls) * 1000) / 10 : null;

  const customerQuoteJobs = quoteJobs.filter((job) => !excludedUserIds.has(job.userId));
  let quoteDone = 0;
  let quoteFailed = 0;
  let quoteCanceled = 0;
  let quoteInFlight = 0;
  for (const job of customerQuoteJobs) {
    if (job.status === "done") quoteDone += 1;
    else if (job.status === "failed") quoteFailed += 1;
    else if (job.status === "canceled") quoteCanceled += 1;
    else if (!TERMINAL_JOB_STATUSES.has(job.status)) quoteInFlight += 1;
  }

  const topTools: McpTopToolRow[] = Array.from(toolAcc.values())
    .map((entry) => ({
      toolName: entry.toolName,
      calls: entry.calls,
      customerCalls: entry.customerCalls,
      realErrors: entry.realErrors,
      notReadyPolls: entry.notReadyPolls,
      customerUsers: entry.customerUserIds.size,
    }))
    .sort(
      (a, b) =>
        b.calls - a.calls ||
        b.customerCalls - a.customerCalls ||
        a.toolName.localeCompare(b.toolName),
    )
    .slice(0, 6);

  const topClients: McpClientFamilyRow[] = Array.from(clientAcc.values())
    .sort(
      (a, b) =>
        b.calls - a.calls ||
        b.customerCalls - a.customerCalls ||
        a.family.localeCompare(b.family),
    )
    .slice(0, 5);

  return {
    tokens: {
      active: activeTokens,
      customerActive: customerActiveTokens,
      total: tokens.length,
      customerUsersEverUsed: customerTokenUsersEver.size,
    },
    calls: {
      total: auditRows.length,
      customerCalls,
      internalCalls,
      activeCustomerUsers: activeCustomerUsers.size,
      okCalls,
      notReadyPolls,
      realErrorCalls,
      deniedCalls,
      realSuccessPct,
    },
    quoteJobs: {
      total: customerQuoteJobs.length,
      done: quoteDone,
      failed: quoteFailed,
      canceled: quoteCanceled,
      inFlight: quoteInFlight,
    },
    topTools,
    topClients,
  };
}

export async function readInsightsMcpUsage(input: {
  since: Date;
  now: Date;
  excludedUserIds?: Iterable<string>;
}): Promise<InsightsMcpUsage> {
  const { since, now } = input;
  const [tokens, auditRows, quoteJobs, fetchedUsers] = await Promise.all([
    prisma.mcpToken.findMany({
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
      },
    }),
    // Deliberately omits payload/network columns so no draft content, URLs, or client IPs are read.
    prisma.toolCallAudit.findMany({
      where: { createdAt: { gte: since, lte: now } },
      select: {
        userId: true,
        toolName: true,
        status: true,
        responseJson: true,
        userAgent: true,
      },
      orderBy: { createdAt: "desc" },
      take: MCP_AUDIT_WINDOW_ROW_CAP,
    }),
    prisma.videoJob.findMany({
      where: {
        budgetQuoteId: { not: null },
        createdAt: { gte: since, lte: now },
      },
      select: {
        userId: true,
        status: true,
      },
    }),
    input.excludedUserIds === undefined
      ? prisma.user.findMany({ select: { id: true, email: true, role: true } })
      : Promise.resolve(null),
  ]);

  const excludedUserIds =
    input.excludedUserIds !== undefined
      ? new Set(input.excludedUserIds)
      : buildInternalOrAdminUserIds(fetchedUsers ?? []);

  return summarizeInsightsMcpUsage({
    now,
    excludedUserIds,
    tokens,
    auditRows,
    quoteJobs,
  });
}
