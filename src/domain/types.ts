
/** Severity of an individual finding, ordered from least to most serious. */
export enum FindingSeverity {
  Informational = 'informational',
  Minor = 'minor',
  Major = 'major',
  Critical = 'critical',
}

/** Lifecycle state of a single finding (its remediation / CAPA progress). */
export enum FindingStatus {
  Open = 'open',
  InRemediation = 'in_remediation',
  Resolved = 'resolved',
  WaivedRisk = 'waived_risk',
}

/** Lifecycle state of the whole audit. Governs which mutations are allowed. */
export enum AuditStatus {
  Draft = 'draft',
  InReview = 'in_review',
  Submitted = 'submitted',
  Closed = 'closed',
}

/** A single reviewer comment attached to a finding. */
export interface Comment {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string; // ISO-8601
}

/** A deficiency discovered during the audit. */
export interface Finding {
  id: string;
  /** Human-facing short code, unique within the audit, e.g. "F-001". */
  code: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  status: FindingStatus;
  /** The accreditation standard clause this finding maps to, e.g. "MM.03.01.01". */
  standardClause: string;
  /** Owner responsible for remediation. */
  assignedTo: string | null;
  /** Remediation due date (ISO-8601 date). */
  dueDate: string | null;
  /** Weight used by the risk-scoring business rule (0–100). */
  riskWeight: number;
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

/** Free-form-but-typed metadata about the audit engagement. */
export interface AuditMetadata {
  facilityName: string;
  facilityId: string;
  standard: string; // e.g. "DNV NIAHO", "TJC"
  surveyorName: string;
  region: string;
  tags: string[];
}

/** A stored attachment reference (the bytes live in the storage layer). */
export interface Attachment {
  id: string;
  auditId: string;
  filename: string; // sanitized, server-controlled
  originalFilename: string; // as uploaded, for display only
  contentType: string;
  sizeBytes: number;
  storageKey: string; // opaque key understood by the storage driver
  checksumSha256: string;
  uploadedBy: string;
  uploadedAt: string;
}

/** The aggregate root. */
export interface ComplianceAudit {
  id: string;
  /** Unique business key: one audit per facility per period. */
  auditKey: string;
  title: string;
  status: AuditStatus;
  metadata: AuditMetadata;
  findings: Finding[];
  attachments: Attachment[];
  /** Monotonic version for optimistic concurrency control. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Computed metrics — never stored, always derived on read. Keeping these out of
 * the persisted document means we can add or change metrics without a migration
 * (see design.md, "Evolving spec").
 */
export interface AuditMetrics {
  totalFindings: number;
  findingsBySeverity: Record<FindingSeverity, number>;
  findingsByStatus: Record<FindingStatus, number>;
  openFindings: number;
  overdueFindings: number;
  /** Weighted risk score in [0, 100]; see MetricsService. */
  riskScore: number;
  /** Derived readiness label based on riskScore and open criticals. */
  accreditationReadiness: 'ready' | 'at_risk' | 'not_ready';
  /** Coarse trend indicator comparing recent vs. older finding creation. */
  trend: 'improving' | 'stable' | 'worsening';
  resolvedRatio: number; // 0–1
}