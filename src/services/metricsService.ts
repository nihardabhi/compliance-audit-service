import {
  AuditMetrics,
  ComplianceAudit,
  FindingSeverity,
  FindingStatus,
} from '../domain/types';

const SEVERITY_MULTIPLIER: Record<FindingSeverity, number> = {
  [FindingSeverity.Critical]: 4,
  [FindingSeverity.Major]: 3,
  [FindingSeverity.Minor]: 2,
  [FindingSeverity.Informational]: 1,
};

const RESOLVED_STATUSES = new Set<FindingStatus>([
  FindingStatus.Resolved,
  FindingStatus.WaivedRisk,
]);

const OPEN_STATUSES = new Set<FindingStatus>([
  FindingStatus.Open,
  FindingStatus.InRemediation,
]);

/** Maximum possible raw score — used for normalisation (500 findings × weight 100 × multiplier 4). */
const MAX_RAW_SCORE = 500 * 100 * 4;

export function computeMetrics(audit: ComplianceAudit, now: Date = new Date()): AuditMetrics {
  const { findings } = audit;

  // ── Counts by severity and status ─────────────────────────────────────────
  const findingsBySeverity = {
    [FindingSeverity.Informational]: 0,
    [FindingSeverity.Minor]: 0,
    [FindingSeverity.Major]: 0,
    [FindingSeverity.Critical]: 0,
  };

  const findingsByStatus = {
    [FindingStatus.Open]: 0,
    [FindingStatus.InRemediation]: 0,
    [FindingStatus.Resolved]: 0,
    [FindingStatus.WaivedRisk]: 0,
  };

  let openFindings = 0;
  let overdueFindings = 0;
  let rawScore = 0;
  let resolvedCount = 0;

  const nowTime = now.getTime();
  const thirtyDaysAgo = nowTime - 30 * 24 * 60 * 60 * 1000;

  let recentCreated = 0;
  let recentResolved = 0;
  let olderCreated = 0;
  let olderResolved = 0;

  for (const f of findings) {
    findingsBySeverity[f.severity]++;
    findingsByStatus[f.status]++;

    if (OPEN_STATUSES.has(f.status)) {
      openFindings++;
      if (f.dueDate && new Date(f.dueDate).getTime() < nowTime) {
        overdueFindings++;
      }
    }

    if (RESOLVED_STATUSES.has(f.status)) {
      resolvedCount++;
    }

    // Risk score: resolved/waived findings count at 10% of their weight.
    const statusFactor = RESOLVED_STATUSES.has(f.status) ? 0.1 : 1;
    rawScore += f.riskWeight * SEVERITY_MULTIPLIER[f.severity] * statusFactor;

    // Trend: bucket by creation time.
    const createdTime = new Date(f.createdAt).getTime();
    if (createdTime >= thirtyDaysAgo) {
      recentCreated++;
      if (RESOLVED_STATUSES.has(f.status)) recentResolved++;
    } else {
      olderCreated++;
      if (RESOLVED_STATUSES.has(f.status)) olderResolved++;
    }
  }

  const totalFindings = findings.length;
  const resolvedRatio = totalFindings === 0 ? 1 : resolvedCount / totalFindings;

  // Normalise to [0, 100], rounded to 1 decimal.
  const riskScore = totalFindings === 0
    ? 0
    : Math.round(Math.min((rawScore / MAX_RAW_SCORE) * 100, 100) * 10) / 10;

  // ── Accreditation readiness ────────────────────────────────────────────────
  const openCriticals = findings.filter(
    (f) => f.severity === FindingSeverity.Critical && OPEN_STATUSES.has(f.status),
  ).length;

  let accreditationReadiness: AuditMetrics['accreditationReadiness'];
  if (riskScore < 30 && openCriticals === 0) {
    accreditationReadiness = 'ready';
  } else if (riskScore < 65 && openCriticals <= 2) {
    accreditationReadiness = 'at_risk';
  } else {
    accreditationReadiness = 'not_ready';
  }

  // ── Trend ─────────────────────────────────────────────────────────────────
  const recentResolutionRate = recentCreated === 0 ? 1 : recentResolved / recentCreated;
  const olderResolutionRate = olderCreated === 0 ? 1 : olderResolved / olderCreated;

  let trend: AuditMetrics['trend'];
  if (recentResolutionRate > olderResolutionRate + 0.1) {
    trend = 'improving';
  } else if (recentResolutionRate < olderResolutionRate - 0.1) {
    trend = 'worsening';
  } else {
    trend = 'stable';
  }

  return {
    totalFindings,
    findingsBySeverity,
    findingsByStatus,
    openFindings,
    overdueFindings,
    riskScore,
    accreditationReadiness,
    trend,
    resolvedRatio,
  };
}