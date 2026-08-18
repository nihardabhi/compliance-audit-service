/**
 * Application error hierarchy.
 *
 * Every error surfaced to a client maps to a stable machine-readable `code`, an
 * HTTP status, and an optional list of field-level details. The global error
 * handler (src/middleware/errorHandler.ts) is the single place that serializes
 * these into the wire format, guaranteeing a consistent error schema.
 */

export interface FieldError {
  field: string;
  message: string;
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE_BUSINESS_KEY'
  | 'PRECONDITION_FAILED'
  | 'VERSION_CONFLICT'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'BUSINESS_RULE_VIOLATION'
  | 'INTERNAL_ERROR';

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: ErrorCode;
  readonly details?: FieldError[];

  constructor(message: string, details?: FieldError[]) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR' as const;
}

export class UnauthenticatedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHENTICATED' as const;
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN' as const;
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND' as const;
}

export class DuplicateBusinessKeyError extends AppError {
  readonly statusCode = 409;
  readonly code = 'DUPLICATE_BUSINESS_KEY' as const;
}

/** Optimistic concurrency failure: caller's version is stale. */
export class VersionConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'VERSION_CONFLICT' as const;
}

export class BusinessRuleViolationError extends AppError {
  readonly statusCode = 422;
  readonly code = 'BUSINESS_RULE_VIOLATION' as const;
}

export class UnsupportedMediaTypeError extends AppError {
  readonly statusCode = 415;
  readonly code = 'UNSUPPORTED_MEDIA_TYPE' as const;
}

export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413;
  readonly code = 'PAYLOAD_TOO_LARGE' as const;
}

export class PreconditionFailedError extends AppError {
  readonly statusCode = 412;
  readonly code = 'PRECONDITION_FAILED' as const;
}