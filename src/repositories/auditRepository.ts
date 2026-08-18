import { Attachment, AuditStatus, ComplianceAudit } from '../domain/types';

/**
 * Persistence abstraction for audits and their attachments.
 *
 * The interface is deliberately shaped like a MongoDB collection so the
 * in-memory implementation used for this exercise can be swapped for a real
 * MongoDB-backed one without touching services:
 *
 *  - `create` / `findById`      → insertOne / findOne({ _id })
 *  - `findByAuditKey`           → findOne({ auditKey })   (unique index)
 *  - `replaceWithVersionCheck`  → findOneAndUpdate({ _id, version }, ...) — this is
 *                                 an atomic compare-and-swap and is exactly how we
 *                                 implement optimistic concurrency control in Mongo.
 *  - `list`                     → find(filter).skip().limit()
 *
 * See design.md → "Concurrency control" and "Schema and data model".
 */
export interface ListOptions {
  page: number;
  size: number;
  status?: AuditStatus;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface AuditRepository {
  create(audit: ComplianceAudit): Promise<ComplianceAudit>;

  findById(id: string): Promise<ComplianceAudit | null>;

  /** Look up by the unique business key. Backs duplicate-key enforcement. */
  findByAuditKey(auditKey: string): Promise<ComplianceAudit | null>;

  /**
   * Atomically replace the document *only if* the stored version matches
   * `expectedVersion`. Returns the new document on success, or null if the
   * version did not match (stale write → caller raises VersionConflictError).
   * The stored `version` is incremented as part of the swap.
   */
  replaceWithVersionCheck(
    id: string,
    expectedVersion: number,
    next: ComplianceAudit,
  ): Promise<ComplianceAudit | null>;

  list(opts: ListOptions): Promise<ListResult<ComplianceAudit>>;

  /** Attach an uploaded file reference to an existing audit. */
  addAttachment(auditId: string, attachment: Attachment): Promise<ComplianceAudit | null>;

  findAttachment(auditId: string, attachmentId: string): Promise<Attachment | null>;
}