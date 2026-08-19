import { env } from './config/env';
import { registerAuditCreatedJob } from './jobs/auditCreatedJob';
import { jobQueue } from './jobs/jobQueue';
import { InMemoryAuditRepository } from './repositories/inMemoryAuditRepository';
import { MongoAuditRepository } from './repositories/mongoAuditRepository';
import { AttachmentService } from './services/attachmentService';
import { AuditService } from './services/auditService';
import { LocalStorageDriver } from './storage/localStorageDriver';
import { S3StorageDriver } from './storage/s3StorageDriver';
import { systemClock } from './utils/clock';
import { logger } from './utils/logger';
import { createApp } from './app';

async function main(): Promise<void> {
  // Repository
  const repo = env.MONGODB_URI
    ? await MongoAuditRepository.connect(env.MONGODB_URI, env.MONGODB_DB)
    : new InMemoryAuditRepository();

  logger.info(
    { driver: env.MONGODB_URI ? 'mongodb' : 'in-memory' },
    'repository initialised',
  );

  // Storage
  const storage = env.STORAGE_DRIVER === 's3'
    ? new S3StorageDriver()
    : new LocalStorageDriver();

  logger.info({ storageDriver: env.STORAGE_DRIVER }, 'storage driver initialised');

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
    server.close(async () => {
      if (repo instanceof MongoAuditRepository) {
        await repo.close();
        logger.info('MongoDB connection closed');
      }
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