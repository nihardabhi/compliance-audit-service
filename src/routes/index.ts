import { Router } from 'express';
import { AttachmentService } from '../services/attachmentService';
import { AuditService } from '../services/auditService';
import { createAuditRouter } from './auditRoutes';

export function createRootRouter(
  auditService: AuditService,
  attachmentService: AttachmentService,
): Router {
  const router = Router();
  router.use('/audits', createAuditRouter(auditService, attachmentService));
  return router;
}