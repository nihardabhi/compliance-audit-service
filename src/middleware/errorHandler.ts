import { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors';


export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // next is required by Express's 4-arg error handler signature even if unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    req.log?.warn({ code: err.code, status: err.statusCode }, err.message);

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        requestId: req.requestId,
        ...(err.details?.length ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Unknown / unexpected errors — never leak internals to the client.
  req.log?.error({ err }, 'Unhandled error');

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: req.requestId,
    },
  });
}