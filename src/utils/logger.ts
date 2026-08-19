import pino from 'pino';
import { env, isProduction } from '../config/env';

const prettyTransport = (() => {
  if (isProduction) {
    return undefined;
  }

  try {
    require.resolve('pino-pretty');
    return {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    };
  } catch {
    // In minimal Docker/runtime images we may not install devDependencies.
    // Fall back to plain JSON logs instead of crashing on startup.
    return undefined;
  }
})();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'compliance-audit-service' },
  redact: {
    // Never log secrets or bearer tokens, even accidentally.
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    censor: '[REDACTED]',
  },
  ...(prettyTransport ? { transport: prettyTransport } : {}),
});