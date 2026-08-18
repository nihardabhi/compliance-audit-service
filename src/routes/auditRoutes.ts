import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { validateBody } from '../middleware/validateBody';
import {
  createAuditSchema,
  getAuditQuerySchema,
  updateAuditSchema,
} from '../schemas/audit.schemas';
import { AttachmentService } from '../services/attachmentService';
import { AuditService } from '../services/auditService';
import { verifyDownloadToken } from '../storage/downloadToken';
import { UnauthenticatedError, ValidationError } from '../utils/errors';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES },
});

export function createAuditRouter(
  auditService: AuditService,
  attachmentService: AttachmentService,
): Router {
  const router = Router();

  // ── GET /audits/:id ────────────────────────────────────────────────────────
  
  router.get(
    '/:id',
    authenticate,
    authorize('audit:read'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { id } = req.params as { id: string };

        const paramsResult = getAuditQuerySchema.safeParse(req.query);
        if (!paramsResult.success) {
          const details = paramsResult.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          }));
          throw new ValidationError('Invalid query parameters', details);
        }

        const result = await auditService.getAudit(id, paramsResult.data);
        res.json({ data: result });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /audits ───────────────────────────────────────────────────────────

  router.post(
    '/',
    authenticate,
    authorize('audit:create'),
    validateBody(createAuditSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const audit = await auditService.createAudit(
          req.body as ReturnType<typeof createAuditSchema.parse>,
          req.user!,
          req.requestId,
        );

        res
          .status(201)
          .setHeader('Location', `/audits/${audit.id}`)
          .setHeader('ETag', `"${audit.version}"`)
          .json({ data: audit });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PUT /audits/:id ────────────────────────────────────────────────────────

  router.put(
    '/:id',
    authenticate,
    authorize('audit:update'),
    validateBody(updateAuditSchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { id } = req.params as { id: string };

        // Read If-Match header for ETag-based optimistic concurrency.
        // Client sends: If-Match: "3" — strip quotes and parse to number.
        let ifMatchVersion: number | undefined;
        const ifMatch = req.headers['if-match'];
        if (typeof ifMatch === 'string') {
          const parsed = parseInt(ifMatch.replace(/"/g, ''), 10);
          if (!Number.isNaN(parsed)) {
            ifMatchVersion = parsed;
          }
        }

        const audit = await auditService.updateAudit(
          id,
          req.body as ReturnType<typeof updateAuditSchema.parse>,
          ifMatchVersion,
          req.user!,
          req.requestId,
        );

        res.setHeader('ETag', `"${audit.version}"`).json({ data: audit });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /audits/:id/attachment ────────────────────────────────────────────

  router.post(
    '/:id/attachment',
    authenticate,
    authorize('attachment:upload'),
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { id } = req.params as { id: string };

        if (!req.file) {
          throw new ValidationError(
            'No file provided. Send multipart/form-data with a "file" field.',
          );
        }

        const result = await attachmentService.upload(
          id,
          {
            buffer:       req.file.buffer,
            originalname: req.file.originalname,
            mimetype:     req.file.mimetype,
            size:         req.file.size,
          },
          req.user!,
        );

        res.status(201).json({
          data:                  result.attachment,
          downloadToken:         result.downloadToken,
          tokenExpiresInSeconds: env.DOWNLOAD_TOKEN_TTL_SECONDS,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /audits/:id/attachment/:attachmentId/token ─────────────────────────
  // Authenticated — issues a fresh short-lived download token.

  router.get(
    '/:id/attachment/:attachmentId/token',
    authenticate,
    authorize('attachment:download'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { id, attachmentId } = req.params as {
          id: string;
          attachmentId: string;
        };

        const downloadToken = await attachmentService.getDownloadToken(id, attachmentId);

        res.json({
          downloadToken,
          tokenExpiresInSeconds: env.DOWNLOAD_TOKEN_TTL_SECONDS,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /audits/:id/attachment/:attachmentId/download?token=xxx ────────────
  // No JWT required — the signed token carries the authorization.
  router.get(
    '/:id/attachment/:attachmentId/download',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { id, attachmentId } = req.params as {
          id: string;
          attachmentId: string;
        };

        // Safely extract token — query values can be string | string[] | undefined.
        const rawToken = req.query['token'];
        const token =
          typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null;

        if (!token) {
          throw new UnauthenticatedError('Missing download token');
        }

        const verified = verifyDownloadToken(token);
        if (!verified.ok) {
          throw new UnauthenticatedError(
            verified.reason === 'expired'
              ? 'Download token has expired'
              : 'Invalid download token',
          );
        }

        // Prevent token reuse across different resources.
        if (
          verified.payload.auditId      !== id ||
          verified.payload.attachmentId !== attachmentId
        ) {
          throw new UnauthenticatedError(
            'Token does not match the requested resource',
          );
        }

        const { stream, attachment } = await attachmentService.streamAttachment(
          id,
          attachmentId,
        );

        res.setHeader('Content-Type', attachment.contentType);
        res.setHeader('Content-Length', attachment.sizeBytes);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${attachment.originalFilename}"`,
        );
        res.setHeader('Cache-Control', 'no-store');

        stream.pipe(res);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}