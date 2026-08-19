import { z } from 'zod';
import { AuthUser } from '../domain/auth';
import { AuditStatus, ChangeLogEntry, ComplianceAudit, Finding } from '../domain/types';
import { AUDIT_CREATED_JOB } from '../jobs/auditCreatedJob';
import { JobQueue } from '../jobs/jobQueue';
import { AuditRepository } from '../repositories/auditRepository';
import { CreateAuditInput, FindingInput, UpdateAuditInput, getAuditQuerySchema } from '../schemas/audit.schemas';
import { Clock, generateId } from '../utils/clock';
import {
  BusinessRuleViolationError,
  DuplicateBusinessKeyError,
  NotFoundError,
  VersionConflictError,
} from '../utils/errors';
import { buildFullResponse, buildSummaryResponse } from './formatService';
import { computeMetrics } from './metricsService';

type QueryParams = z.infer<typeof getAuditQuerySchema>;

/**
 * Custom business rule — Status Transition Guard:
 * Audits follow a one-way lifecycle: Draft → InReview → Submitted → Closed.
 * Closed is a terminal state — fully immutable.
 */
const ALLOWED_TRANSITIONS: Record<AuditStatus, AuditStatus[]> = {
  [AuditStatus.Draft]:     [AuditStatus.InReview],
  [AuditStatus.InReview]:  [AuditStatus.Submitted, AuditStatus.Draft],
  [AuditStatus.Submitted]: [AuditStatus.Closed, AuditStatus.InReview],
  [AuditStatus.Closed]:    [],
};

function mapFindingInput(input: FindingInput, existing?: Finding): Finding {
  const now = new Date().toISOString();
  return {
    id:             existing?.id ?? generateId(),
    code:           input.code,
    title:          input.title,
    description:    input.description,
    severity:       input.severity,
    status:         input.status,
    standardClause: input.standardClause,
    assignedTo:     input.assignedTo,
    dueDate:        input.dueDate,
    riskWeight:     input.riskWeight,
    comments:       existing?.comments ?? [],
    createdAt:      existing?.createdAt ?? now,
    updatedAt:      now,
  };
}

export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly clock: Clock,
    private readonly queue: JobQueue,
  ) {}

  async createAudit(
    input: CreateAuditInput,
    user: AuthUser,
    requestId: string,
  ): Promise<ComplianceAudit> {
    const existing = await this.repo.findByAuditKey(input.auditKey);
    if (existing) {
      throw new DuplicateBusinessKeyError(
        `An audit with auditKey '${input.auditKey}' already exists`,
      );
    }

    const now = this.clock.nowIso();
    const audit: ComplianceAudit = {
      id:       generateId(),
      auditKey: input.auditKey,
      title:    input.title,
      status:   AuditStatus.Draft,
      metadata: {
        facilityName:  input.metadata.facilityName,
        facilityId:    input.metadata.facilityId,
        standard:      input.metadata.standard,
        surveyorName:  input.metadata.surveyorName,
        region:        input.metadata.region,
        tags:          input.metadata.tags ?? [],
      },
      findings:    (input.findings ?? []).map((f) => mapFindingInput(f)),
      attachments: [],
      changeLog:   [],
      version:     1,
      createdBy:   user.sub,
      createdAt:   now,
      updatedAt:   now,
    };

    const created = await this.repo.create(audit);

    this.queue.enqueue<{ auditId: string }>(
      AUDIT_CREATED_JOB,
      { auditId: created.id },
      { requestId },
    );

    return created;
  }

  async getAudit(id: string, params: QueryParams): Promise<unknown> {
    const audit = await this.repo.findById(id);
    if (!audit) {
      throw new NotFoundError(`Audit '${id}' not found`);
    }

    const metrics = computeMetrics(audit);

    if (params.view === 'summary') {
      return buildSummaryResponse(audit, metrics);
    }

    return buildFullResponse(audit, metrics, params);
  }

  async updateAudit(
    id: string,
    input: UpdateAuditInput,
    expectedVersion: number | undefined,
    user: AuthUser,
    requestId: string,
  ): Promise<ComplianceAudit> {
    const audit = await this.repo.findById(id);
    if (!audit) {
      throw new NotFoundError(`Audit '${id}' not found`);
    }

    if (audit.status === AuditStatus.Closed) {
      throw new BusinessRuleViolationError(
        'Closed audits are immutable and cannot be updated',
      );
    }

    if (input.status && input.status !== audit.status) {
      const allowed = ALLOWED_TRANSITIONS[audit.status];
      if (!allowed.includes(input.status)) {
        throw new BusinessRuleViolationError(
          `Status transition '${audit.status}' → '${input.status}' is not allowed`,
        );
      }
    }

    const version = input.expectedVersion ?? expectedVersion ?? audit.version;

    const existingByCode = new Map(audit.findings.map((f) => [f.code, f]));
    const mergedFindings: Finding[] = input.findings
      ? input.findings.map((f) => mapFindingInput(f, existingByCode.get(f.code)))
      : audit.findings;

    // Build a before/after diff of every field that actually changed.
    const changes: ChangeLogEntry['changes'] = {};
    if (input.title !== undefined && input.title !== audit.title) {
      changes['title'] = { before: audit.title, after: input.title };
    }
    if (input.status !== undefined && input.status !== audit.status) {
      changes['status'] = { before: audit.status, after: input.status };
    }
    if (input.metadata !== undefined) {
      changes['metadata'] = {
        before: audit.metadata,
        after:  { ...audit.metadata, ...input.metadata },
      };
    }
    if (input.findings !== undefined) {
      changes['findings'] = {
        before: `${audit.findings.length} finding(s)`,
        after:  `${input.findings.length} finding(s)`,
      };
    }

    const now = this.clock.nowIso();
    const entry: ChangeLogEntry = { at: now, by: user.sub, requestId, changes };

    const next: ComplianceAudit = {
      ...audit,
      title:    input.title    ?? audit.title,
      status:   input.status   ?? audit.status,
      metadata: input.metadata ? { ...audit.metadata, ...input.metadata } : audit.metadata,
      findings: mergedFindings,
      changeLog: [...(audit.changeLog ?? []), entry],
      updatedAt: now,
    };

    const updated = await this.repo.replaceWithVersionCheck(id, version, next);
    if (!updated) {
      throw new VersionConflictError(
        `Version conflict: expected version ${version} but the document has been modified. Fetch the latest and retry.`,
      );
    }

    return updated;
  }
}