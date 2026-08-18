import { NextFunction, Request, Response } from 'express';
import { can, Permission } from '../domain/auth';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors';

export function authorize(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthenticatedError('Request is not authenticated'));
      return;
    }
    if (!can(req.user, permission)) {
      next(
        new ForbiddenError(
          `You do not have permission to perform '${permission}'`,
        ),
      );
      return;
    }
    next();
  };
}