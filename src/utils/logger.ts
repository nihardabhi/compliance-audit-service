import pino from 'pino';
import { env, isProduction } from '../config/env';

/**
 * Root logger. Child loggers are created per-request in the request-context
 * middleware so that every log line carries a request/trace id.
 *
 * In production we emit newline-delimited JSON (ingested by CloudWatch / Datadog).
 * In development we pretty-print for readability.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'compliance-audit-service' },
  redact: {
    // Never log secrets or bearer tokens, even accidentally.
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    censor: '[REDACTED]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }),
});