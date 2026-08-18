import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId =
    (typeof req.headers['x-request-id'] === 'string'
      ? req.headers['x-request-id']
      : null) ?? randomUUID();

  req.requestId = requestId;
  req.log = logger.child({ requestId });

  // Echo the requestId back so clients can correlate responses to their requests.
  res.setHeader('X-Request-Id', requestId);

  next();
}