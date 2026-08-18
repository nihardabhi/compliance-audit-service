import { env } from './config/env';
import { registerAuditCreatedJob } from './jobs/auditCreatedJob';
import { jobQueue } from './jobs/jobQueue';
import { InMemoryAuditRepository } from './repositories/inMemoryAuditRepository';
import { AttachmentService } from './services/attachmentService';
import { AuditService } from './services/auditService';
import { LocalStorageDriver } from './storage/localStorageDriver';
import { systemClock } from './utils/clock';
import { logger } from './utils/logger';
import { createApp } from './app';

async function main(): Promise<void> {
  const repo    = new InMemoryAuditRepository();
  const storage = new LocalStorageDriver();

  registerAuditCreatedJob(repo);
  jobQueue.start();

  const auditService      = new AuditService(repo, systemClock, jobQueue);
  const attachmentService = new AttachmentService(repo, storage, systemClock);

  const app    = createApp(auditService, attachmentService);
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, nodeEnv: env.NODE_ENV },
      'compliance-audit-service listening',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown signal received — draining');
    jobQueue.stop();
    server.close(() => {
      logger.info('HTTP server closed cleanly');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandledRejection — exiting');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  console.error('Fatal: failed to start service', err);
  process.exit(1);
});