import { z } from 'zod';
import { AuditMetrics, ComplianceAudit, Finding, FindingSeverity, FindingStatus } from '../domain/types';
import { getAuditQuerySchema } from '../schemas/audit.schemas';

type QueryParams = z.infer<typeof getAuditQuerySchema>;

/** Severity ordering for sort — lower index = less severe. */
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  [FindingSeverity.Informational]: 0,
  [FindingSeverity.Minor]: 1,
  [FindingSeverity.Major]: 2,
  [FindingSeverity.Critical]: 3,
};

// ── Finding helpers ───────────────────────────────────────────────────────────

function filterFindings(findings: Finding[], params: QueryParams): Finding[] {
  let result = findings;

  if (params.severity) {
    result = result.filter((f) => f.severity === params.severity);
  }
  if (params.findingStatus) {
    result = result.filter((f) => f.status === (params.findingStatus as FindingStatus));
  }
  return result;
}

function sortFindings(findings: Finding[], sort: QueryParams['sort']): Finding[] {
  const copy = [...findings];
  const [field, dir] = sort.split(':') as [string, 'asc' | 'desc'];
  const asc = dir === 'asc' ? 1 : -1;

  copy.sort((a, b) => {
    if (field === 'severity') {
      return asc * (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    }
    if (field === 'dueDate') {
      const aVal = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bVal = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return asc * (aVal - bVal);
    }
    // createdAt (default)
    return asc * a.createdAt.localeCompare(b.createdAt);
  });

  return copy;
}

function paginateFindings(
  findings: Finding[],
  page: number,
  size: number,
): { items: Finding[]; total: number } {
  const total = findings.length;
  const start = (page - 1) * size;
  return { items: findings.slice(start, start + size), total };
}

// ── Full view ─────────────────────────────────────────────────────────────────

export function buildFullResponse(
  audit: ComplianceAudit,
  metrics: AuditMetrics | null,
  params: QueryParams,
) {
  const include = new Set(params.include);
  const includeAll = include.size === 0;

  // Findings: filter → sort → paginate, then optionally strip comments.
  let findingsPayload: unknown = undefined;

  if (includeAll || include.has('findings')) {
    const filtered = filterFindings(audit.findings, params);
    const sorted = sortFindings(filtered, params.sort);
    const { items, total } = paginateFindings(sorted, params.page, params.size);

    const findingsWithComments = items.map((f) => ({
      ...f,
      comments:
        includeAll || include.has('comments')
          ? f.comments
          : undefined,
    }));

    findingsPayload = {
      items: findingsWithComments,
      pagination: {
        total,
        page: params.page,
        size: params.size,
        totalPages: Math.ceil(total / params.size),
      },
    };
  }

  return {
    id: audit.id,
    auditKey: audit.auditKey,
    title: audit.title,
    status: audit.status,
    metadata: audit.metadata,
    version: audit.version,
    createdBy: audit.createdBy,
    createdAt: audit.createdAt,
    updatedAt: audit.updatedAt,
    ...(findingsPayload !== undefined && { findings: findingsPayload }),
    ...(includeAll || include.has('metrics') ? { metrics } : {}),
    ...(includeAll || include.has('attachments')
      ? { attachments: audit.attachments }
      : {}),
    ...(include.has('changeLog')
      ? { changeLog: audit.changeLog ?? [] }
      : {}),
  };
}

// ── Summary view ──────────────────────────────────────────────────────────────

/**
 * Flat, human-readable summary — useful for list views or dashboards.
 * Returns only scalar fields + top-level aggregates. No nested arrays.
 */
export function buildSummaryResponse(
  audit: ComplianceAudit,
  metrics: AuditMetrics,
) {
  return {
    id: audit.id,
    auditKey: audit.auditKey,
    title: audit.title,
    status: audit.status,
    facilityName: audit.metadata.facilityName,
    standard: audit.metadata.standard,
    region: audit.metadata.region,
    totalFindings: metrics.totalFindings,
    openFindings: metrics.openFindings,
    overdueFindings: metrics.overdueFindings,
    riskScore: metrics.riskScore,
    accreditationReadiness: metrics.accreditationReadiness,
    trend: metrics.trend,
    resolvedRatio: metrics.resolvedRatio,
    attachmentCount: audit.attachments.length,
    version: audit.version,
    createdAt: audit.createdAt,
    updatedAt: audit.updatedAt,
  };
}