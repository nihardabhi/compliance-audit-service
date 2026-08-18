import cors from 'cors';
import express, { Application, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { errorHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { createRootRouter } from './routes';
import { AttachmentService } from './services/attachmentService';
import { AuditService } from './services/auditService';

export function createApp(
  auditService: AuditService,
  attachmentService: AttachmentService,
): Application {
  const app = express();

  // Security headers 
  app.use(helmet());

  // CORS 
  // In production, replace '*' with an explicit allowlist of client origins.

  app.use(
    cors({
      origin: process.env['CORS_ORIGIN'] ?? '*',
      methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'If-Match', 'X-Request-Id'],
      exposedHeaders: ['Location', 'ETag', 'X-Request-Id'],
    }),
  );

  // ── Request context (requestId + child logger) — must be before routes ─────
  app.use(requestContext);

  // Body parsers
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Request logging 
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.log.info({ method: req.method, url: req.originalUrl }, 'request received');
    next();
  });

  // ── Health check — unauthenticated, for Docker / k8s liveness probes ───────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── API routes ─────────────────────────────────────────────────────────────
  app.use('/api/v1', createRootRouter(auditService, attachmentService));

  // ── 404 handler ────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested endpoint does not exist',
      },
    });
  });

  // ── Global error handler — must be registered last ─────────────────────────
  app.use(errorHandler);

  return app;
}