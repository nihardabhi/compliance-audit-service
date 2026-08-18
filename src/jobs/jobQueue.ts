import { logger } from '../utils/logger';

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead_lettered';

export interface Job<T> {
  readonly id: string;
  readonly type: string;
  readonly payload: T;
  readonly requestId: string;
  readonly createdAt: number; // epoch ms
  status: JobStatus;
  attempts: number;
  readonly maxAttempts: number;
  nextRunAt: number; // epoch ms
  lastError?: string;
}

export type JobHandler<T> = (job: Job<T>) => Promise<void>;

interface RegisteredHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: JobHandler<any>;
}

const BASE_DELAY_MS = 1_000; // 1 s — doubles each retry
const TICK_INTERVAL_MS = 500;

let jobCounter = 0;

function generateJobId(): string {
  return `job-${Date.now()}-${++jobCounter}`;
}

function backoffDelay(attempt: number): number {
  // 1 s, 2 s, 4 s, 8 s … capped at 60 s
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 60_000);
}

export class JobQueue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly jobs = new Map<string, Job<any>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly deadLetter: Job<any>[] = [];
  private readonly handlers = new Map<string, RegisteredHandler>();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /** Register the handler for a given job type. Must be called before start(). */
  register<T>(type: string, handler: JobHandler<T>): void {
    this.handlers.set(type, { handler });
  }

  /**
   * Enqueue a new job. Returns the job id.
   * `requestId` is propagated to the handler's log context for traceability.
   */
  enqueue<T>(
    type: string,
    payload: T,
    options: { requestId: string; maxAttempts?: number } = { requestId: 'system' },
  ): string {
    const id = generateJobId();
    const job: Job<T> = {
      id,
      type,
      payload,
      requestId: options.requestId,
      createdAt: Date.now(),
      status: 'pending',
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      nextRunAt: Date.now(),
    };
    this.jobs.set(id, job);
    logger.info({ jobId: id, type, requestId: options.requestId }, 'job.enqueued');
    return id;
  }

  /** Start the processing loop. Call once at app boot. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleTick();
    logger.info('job-queue: started');
  }

  /** Graceful shutdown — waits for the current tick to finish. */
  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    logger.info('job-queue: stopped');
  }

  getDeadLettered(): readonly Job<unknown>[] {
    return this.deadLetter;
  }

  getJob(id: string): Job<unknown> | undefined {
    return this.jobs.get(id);
  }

  private scheduleTick(): void {
    if (!this.running) return;
    this.tickTimer = setTimeout(() => void this.tick(), TICK_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const due = Array.from(this.jobs.values()).filter(
      (j) => j.status === 'pending' && j.nextRunAt <= now,
    );

    for (const job of due) {
      await this.runJob(job);
    }

    this.scheduleTick();
  }

  private async runJob(job: Job<unknown>): Promise<void> {
    const registered = this.handlers.get(job.type);
    if (!registered) {
      logger.error({ jobId: job.id, type: job.type }, 'job-queue: no handler registered');
      job.status = 'dead_lettered';
      this.deadLetter.push(job);
      this.jobs.delete(job.id);
      return;
    }

    job.status = 'running';
    job.attempts++;

    const jobLogger = logger.child({
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      requestId: job.requestId,
    });

    jobLogger.info('job.attempt.start');

    try {
      await registered.handler(job);
      job.status = 'succeeded';
      jobLogger.info('job.attempt.succeeded');
      this.jobs.delete(job.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      job.lastError = message;
      jobLogger.warn({ err: message }, 'job.attempt.failed');

      if (job.attempts >= job.maxAttempts) {
        job.status = 'dead_lettered';
        jobLogger.error(
          { attempts: job.attempts },
          'job.dead_lettered: max retries exhausted',
        );
        this.deadLetter.push(job);
        this.jobs.delete(job.id);
      } else {
        job.status = 'pending';
        job.nextRunAt = Date.now() + backoffDelay(job.attempts);
        jobLogger.info(
          { nextRunAt: new Date(job.nextRunAt).toISOString() },
          'job.attempt.scheduled_retry',
        );
      }
    }
  }
}

/** Singleton queue instance shared across the application. */
export const jobQueue = new JobQueue();