import crypto from 'crypto';
import { Readable } from 'stream';
import { AuthUser } from '../domain/auth';
import { Attachment } from '../domain/types';
import { AuditRepository } from '../repositories/auditRepository';
import { StorageDriver } from '../storage/storageDriver';
import { issueDownloadToken } from '../storage/downloadToken';
import { Clock, generateId } from '../utils/clock';
import {
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from '../utils/errors';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import path from 'path';

/**
 * Allowed MIME types for attachments.
 * Keeping the allowlist narrow reduces the attack surface for content-type
 * confusion attacks and makes virus-scanning scope predictable.
 */

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // xlsx
  'text/csv',
  'text/plain',
]);

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/tiff': 'tiff',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface AttachmentUploadResult {
  attachment: Attachment;
  /** Short-lived signed download URL — valid for DOWNLOAD_TOKEN_TTL_SECONDS. */
  downloadToken: string;
}

export class AttachmentService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly storage: StorageDriver,
    private readonly clock: Clock,
  ) {}

  async upload(
    auditId: string,
    file: UploadedFile,
    user: AuthUser,
  ): Promise<AttachmentUploadResult> {
    // Verify the audit exists before doing any I/O.
    const audit = await this.repo.findById(auditId);
    if (!audit) {
      throw new NotFoundError(`Audit '${auditId}' not found`);
    }

    // Validate size.
    if (file.size > env.MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeError(
        `File exceeds maximum allowed size of ${env.MAX_UPLOAD_BYTES} bytes`,
      );
    }

    // Validate MIME type against the allowlist.
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new UnsupportedMediaTypeError(
        `Content type '${file.mimetype}' is not permitted. Allowed types: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      );
    }

    // Compute SHA-256 checksum for integrity verification.
    const checksumSha256 = crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex');

    const ext = MIME_TO_EXT[file.mimetype] ?? 'bin';
    const attachmentId = generateId();
    const storageKey = `${attachmentId}.${ext}`;

    // Sanitize the original filename (display only — never used in I/O).
    const sanitizedOriginal = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 255);

    // Write to storage backend.
    const stream = Readable.from(file.buffer);
    await this.storage.put(storageKey, stream, file.mimetype);

    const now = this.clock.nowIso();
    const attachment: Attachment = {
      id: attachmentId,
      auditId,
      filename: storageKey,
      originalFilename: sanitizedOriginal,
      contentType: file.mimetype,
      sizeBytes: file.size,
      storageKey,
      checksumSha256,
      uploadedBy: user.sub,
      uploadedAt: now,
    };

    const updated = await this.repo.addAttachment(auditId, attachment);
    if (!updated) {
      // Storage write succeeded but repo update failed — clean up orphan file.
      await this.storage.delete(storageKey).catch((err) => {
        logger.error({ storageKey, err }, 'attachment-service: failed to clean up orphan file');
      });
      throw new NotFoundError(`Audit '${auditId}' not found during attachment persist`);
    }

    const downloadToken = issueDownloadToken(auditId, attachmentId);

    return { attachment, downloadToken };
  }

  async getDownloadToken(
    auditId: string,
    attachmentId: string,
  ): Promise<string> {
    const attachment = await this.repo.findAttachment(auditId, attachmentId);
    if (!attachment) {
      throw new NotFoundError(`Attachment '${attachmentId}' not found on audit '${auditId}'`);
    }
    return issueDownloadToken(auditId, attachmentId);
  }

  async streamAttachment(auditId: string, attachmentId: string) {
    const attachment = await this.repo.findAttachment(auditId, attachmentId);
    if (!attachment) {
      throw new NotFoundError(`Attachment '${attachmentId}' not found`);
    }
    const stream = await this.storage.get(attachment.storageKey);
    return { stream, attachment };
  }
}