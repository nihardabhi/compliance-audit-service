import { AuditStatus, FindingSeverity, FindingStatus } from '../domain/types';
import { AuditRepository } from '../repositories/auditRepository';
import { computeMetrics } from '../services/metricsService';
import { logger } from '../utils/logger';
import { jobQueue } from './jobQueue';

export const AUDIT_CREATED_JOB = 'audit.created';

export interface AuditCreatedPayload {
  auditId: string;
}

export function registerAuditCreatedJob(repo: AuditRepository): void {
  jobQueue.register<AuditCreatedPayload>(AUDIT_CREATED_JOB, async (job) => {
    const { auditId } = job.payload;

    const jobLogger = logger.child({
      jobId: job.id,
      auditId,
      requestId: job.requestId,
    });

    const audit = await repo.findById(auditId);
    if (!audit) {
      jobLogger.warn('audit-created-job: audit not found, skipping');
      return;
    }

    const metrics = computeMetrics(audit);

    jobLogger.info(
      {
        riskScore: metrics.riskScore,
        accreditationReadiness: metrics.accreditationReadiness,
        openCriticals: audit.findings.filter(
          (f) =>
            f.severity === FindingSeverity.Critical &&
            f.status === FindingStatus.Open,
        ).length,
      },
      'audit-created-job: risk assessment complete',
    );

    const openCriticals = audit.findings.filter(
      (f) =>
        f.severity === FindingSeverity.Critical &&
        (f.status === FindingStatus.Open || f.status === FindingStatus.InRemediation),
    );

    if (audit.status === AuditStatus.Draft && openCriticals.length > 0) {
      const escalated = {
        ...audit,
        status: AuditStatus.InReview,
        updatedAt: new Date().toISOString(),
      };

      const result = await repo.replaceWithVersionCheck(
        audit.id,
        audit.version,
        escalated,
      );

      if (result) {
        jobLogger.warn(
          { openCriticals: openCriticals.length },
          'audit-created-job: auto-escalated to in_review due to open critical findings',
        );
      } else {
        jobLogger.info(
          'audit-created-job: version mismatch on escalation, skipping (concurrent update)',
        );
      }
    }
  });
}