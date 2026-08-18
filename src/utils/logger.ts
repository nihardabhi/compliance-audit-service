import pino from 'pino';
import { env, isProduction } from '../config/env';

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