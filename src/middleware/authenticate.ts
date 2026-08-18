import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AuthUser, Role } from '../domain/auth';
import { env } from '../config/env';
import { UnauthenticatedError } from '../utils/errors';

interface JwtClaims {
  sub: string;
  name: string;
  roles: Role[];
}

function extractToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthenticatedError('Missing or malformed Authorization header');
  }
  return header.slice(7);
}

function isValidRoleArray(value: unknown): value is Role[] {
  return (
    Array.isArray(value) &&
    value.every((r) => Object.values(Role).includes(r as Role))
  );
}

/**
 * Verifies the Bearer JWT and populates req.user.
 * Any request that reaches a protected route without a valid token gets 401.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  try {
    const token = extractToken(req);

    const payload = jwt.verify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as JwtClaims;

    if (!payload.sub || !payload.name || !isValidRoleArray(payload.roles)) {
      throw new UnauthenticatedError('Token is missing required claims (sub, name, roles)');
    }

    const user: AuthUser = {
      sub: payload.sub,
      name: payload.name,
      roles: payload.roles,
    };

    req.user = user;
    req.log = req.log.child({ userId: user.sub, roles: user.roles });

    next();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      next(err);
      return;
    }
    // jsonwebtoken throws TokenExpiredError, JsonWebTokenError, etc.
    next(new UnauthenticatedError('Invalid or expired token'));
  }
}