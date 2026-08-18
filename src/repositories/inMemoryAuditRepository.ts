import { Attachment, ComplianceAudit } from '../domain/types';
import { AuditRepository, ListOptions, ListResult } from './auditRepository';

/**
 * In-memory document store used for the exercise (no DB setup required).
 *
 * It mimics the MongoDB behaviours the service relies on:
 *  - documents are stored by `_id` (here, `id`),
 *  - a secondary index on `auditKey` enforces uniqueness,
 *  - `replaceWithVersionCheck` is an atomic compare-and-swap mirroring
 *    `findOneAndUpdate({ _id, version })`.
 *
 * All records are deep-cloned on the way in and out so callers can never mutate
 * stored state by reference — the same isolation a real driver gives you across
 * a network boundary. structuredClone keeps that honest.
 */
export class InMemoryAuditRepository implements AuditRepository {
  private readonly byId = new Map<string, ComplianceAudit>();
  private readonly keyToId = new Map<string, string>(); // auditKey → id (unique index)

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  async create(audit: ComplianceAudit): Promise<ComplianceAudit> {
    if (this.keyToId.has(audit.auditKey)) {
      // Mirrors a Mongo duplicate-key (E11000) error on the unique index.
      throw new Error(`DUPLICATE_KEY:${audit.auditKey}`);
    }
    const stored = this.clone(audit);
    this.byId.set(stored.id, stored);
    this.keyToId.set(stored.auditKey, stored.id);
    return this.clone(stored);
  }

  async findById(id: string): Promise<ComplianceAudit | null> {
    const found = this.byId.get(id);
    return found ? this.clone(found) : null;
  }

  async findByAuditKey(auditKey: string): Promise<ComplianceAudit | null> {
    const id = this.keyToId.get(auditKey);
    if (!id) {
      return null;
    }
    const found = this.byId.get(id);
    return found ? this.clone(found) : null;
  }

  async replaceWithVersionCheck(
    id: string,
    expectedVersion: number,
    next: ComplianceAudit,
  ): Promise<ComplianceAudit | null> {
    const current = this.byId.get(id);
    if (!current) {
      return null;
    }
    if (current.version !== expectedVersion) {
      // Compare-and-swap failed: another writer moved the version forward.
      return null;
    }
    const stored = this.clone(next);
    stored.version = expectedVersion + 1;
    this.byId.set(id, stored);
    return this.clone(stored);
  }

  async list(opts: ListOptions): Promise<ListResult<ComplianceAudit>> {
    let all = Array.from(this.byId.values());
    if (opts.status) {
      all = all.filter((a) => a.status === opts.status);
    }
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = all.length;
    const start = (opts.page - 1) * opts.size;
    const items = all.slice(start, start + opts.size).map((a) => this.clone(a));
    return { items, total, page: opts.page, size: opts.size };
  }

  async addAttachment(
    auditId: string,
    attachment: Attachment,
  ): Promise<ComplianceAudit | null> {
    const current = this.byId.get(auditId);
    if (!current) {
      return null;
    }
    current.attachments.push(this.clone(attachment));
    current.updatedAt = attachment.uploadedAt;
    return this.clone(current);
  }

  async findAttachment(
    auditId: string,
    attachmentId: string,
  ): Promise<Attachment | null> {
    const current = this.byId.get(auditId);
    if (!current) {
      return null;
    }
    const found = current.attachments.find((a) => a.id === attachmentId);
    return found ? this.clone(found) : null;
  }
}