import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../../src/services/metricsService';
import {
  AuditStatus,
  ComplianceAudit,
  FindingSeverity,
  FindingStatus,
} from '../../src/domain/types';

function makeAudit(overrides: Partial<ComplianceAudit> = {}): ComplianceAudit {
  return {
    id: 'audit-1',
    auditKey: 'FAC-001:2026-Q1',
    title: 'Test Audit',
    status: AuditStatus.Draft,
    metadata: {
      facilityName: 'Test Hospital',
      facilityId: 'FAC-001',
      standard: 'DNV NIAHO',
      surveyorName: 'Jane Smith',
      region: 'Northeast',
      tags: [],
    },
    findings: [],
    attachments: [],
    version: 1,
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('computeMetrics', () => {
  it('returns zero metrics for an audit with no findings', () => {
    const metrics = computeMetrics(makeAudit());

    expect(metrics.totalFindings).toBe(0);
    expect(metrics.openFindings).toBe(0);
    expect(metrics.overdueFindings).toBe(0);
    expect(metrics.riskScore).toBe(0);
    expect(metrics.resolvedRatio).toBe(1);
    expect(metrics.accreditationReadiness).toBe('ready');
    expect(metrics.trend).toBe('stable');
  });

  it('counts findings by severity and status correctly', () => {
    const audit = makeAudit({
      findings: [
        {
          id: 'f1', code: 'F-001', title: 'Critical Finding',
          description: 'desc', severity: FindingSeverity.Critical,
          status: FindingStatus.Open, standardClause: 'MM.01',
          assignedTo: null, dueDate: null, riskWeight: 80,
          comments: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        {
          id: 'f2', code: 'F-002', title: 'Minor Finding',
          description: 'desc', severity: FindingSeverity.Minor,
          status: FindingStatus.Resolved, standardClause: 'MM.02',
          assignedTo: null, dueDate: null, riskWeight: 20,
          comments: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
      ],
    });

    const metrics = computeMetrics(audit);

    expect(metrics.totalFindings).toBe(2);
    expect(metrics.findingsBySeverity[FindingSeverity.Critical]).toBe(1);
    expect(metrics.findingsBySeverity[FindingSeverity.Minor]).toBe(1);
    expect(metrics.findingsByStatus[FindingStatus.Open]).toBe(1);
    expect(metrics.findingsByStatus[FindingStatus.Resolved]).toBe(1);
    expect(metrics.openFindings).toBe(1);
    expect(metrics.resolvedRatio).toBe(0.5);
  });

  it('marks audit as not_ready when open criticals exist', () => {
    const audit = makeAudit({
      findings: [
        {
          id: 'f1', code: 'F-001', title: 'Critical',
          description: 'desc', severity: FindingSeverity.Critical,
          status: FindingStatus.Open, standardClause: 'MM.01',
          assignedTo: null, dueDate: null, riskWeight: 100,
          comments: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
      ],
    });

    const metrics = computeMetrics(audit);
    expect(metrics.accreditationReadiness).toBe('not_ready');
  });

  it('counts overdue findings correctly', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // yesterday
    const audit = makeAudit({
      findings: [
        {
          id: 'f1', code: 'F-001', title: 'Overdue',
          description: 'desc', severity: FindingSeverity.Major,
          status: FindingStatus.Open, standardClause: 'MM.01',
          assignedTo: null, dueDate: pastDate, riskWeight: 50,
          comments: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
      ],
    });

    const metrics = computeMetrics(audit);
    expect(metrics.overdueFindings).toBe(1);
  });
});