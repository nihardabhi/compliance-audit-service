import {
  Collection,
  MongoClient,
  MongoServerError,
  ReturnDocument,
} from 'mongodb';
import { Attachment, ComplianceAudit } from '../domain/types';
import { logger } from '../utils/logger';
import { AuditRepository, ListOptions, ListResult } from './auditRepository';

type AuditDoc = Omit<ComplianceAudit, 'id'> & { _id: string };

function toDoc(audit: ComplianceAudit): AuditDoc {
  const { id, ...rest } = audit;
  return { _id: id, ...rest };
}

function fromDoc(doc: AuditDoc): ComplianceAudit {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

export class MongoAuditRepository implements AuditRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly col: Collection<AuditDoc>,
  ) {}

  static async connect(uri: string, dbName: string): Promise<MongoAuditRepository> {
    const client = new MongoClient(uri, { appName: 'compliance-audit-service' });
    await client.connect();

    const col = client.db(dbName).collection<AuditDoc>('audits');
    await col.createIndex({ auditKey: 1 }, { unique: true, name: 'uq_auditKey' });
    await col.createIndex({ createdAt: -1 }, { name: 'idx_createdAt' });

    logger.info({ dbName }, 'MongoDB connected and indexes ensured');
    return new MongoAuditRepository(client, col);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async create(audit: ComplianceAudit): Promise<ComplianceAudit> {
    try {
      await this.col.insertOne(toDoc(audit));
      return audit;
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        throw new Error(`DUPLICATE_KEY:${audit.auditKey}`);
      }
      throw err;
    }
  }

  async findById(id: string): Promise<ComplianceAudit | null> {
    const doc = await this.col.findOne({ _id: id });
    return doc ? fromDoc(doc) : null;
  }

  async findByAuditKey(auditKey: string): Promise<ComplianceAudit | null> {
    const doc = await this.col.findOne({ auditKey });
    return doc ? fromDoc(doc) : null;
  }

  async replaceWithVersionCheck(
    id: string,
    expectedVersion: number,
    next: ComplianceAudit,
  ): Promise<ComplianceAudit | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: id, version: expectedVersion },
      { $set: { ...toDoc(next), version: expectedVersion + 1 } },
      { returnDocument: ReturnDocument.AFTER },
    );
    return result ? fromDoc(result) : null;
  }

  async list(opts: ListOptions): Promise<ListResult<ComplianceAudit>> {
    const filter = opts.status ? { status: opts.status } : {};
    const skip   = (opts.page - 1) * opts.size;

    const [docs, total] = await Promise.all([
      this.col.find(filter).sort({ createdAt: -1 }).skip(skip).limit(opts.size).toArray(),
      this.col.countDocuments(filter),
    ]);

    return { items: docs.map(fromDoc), total, page: opts.page, size: opts.size };
  }

  async addAttachment(auditId: string, attachment: Attachment): Promise<ComplianceAudit | null> {
    const result = await this.col.findOneAndUpdate(
      { _id: auditId },
      {
        $push: { attachments: attachment },
        $set:  { updatedAt: attachment.uploadedAt },
      },
      { returnDocument: ReturnDocument.AFTER },
    );
    return result ? fromDoc(result) : null;
  }

  async findAttachment(auditId: string, attachmentId: string): Promise<Attachment | null> {
    const doc = await this.col.findOne(
      { _id: auditId, 'attachments.id': attachmentId },
      { projection: { attachments: { $elemMatch: { id: attachmentId } } } },
    );
    if (!doc?.attachments?.[0]) return null;
    return doc.attachments[0] ?? null;
  }
}