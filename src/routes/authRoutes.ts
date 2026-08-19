import { NextFunction, Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Role } from '../domain/auth';
import { env } from '../config/env';
import { UnauthenticatedError, ValidationError } from '../utils/errors';

const USERS: Record<string, { password: string; name: string; roles: Role[] }> = {
  admin: {
    password: 'admin123',
    name: 'Admin User',
    roles: [Role.Admin],
  },
  user: {
    password: 'user123',
    name: 'Regular User',
    roles: [Role.User],
  },
};

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export function createAuthRouter(): Router {
  const router = Router();

  /**
   * POST /auth/login
   * Body: { username, password }
   * Returns: { token, expiresIn, user: { sub, name, roles } }
   */
  router.post(
    '/login',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = loginSchema.safeParse(req.body);
        if (!parsed.success) {
          const details = parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          }));
          throw new ValidationError('username and password are required', details);
        }

        const { username, password } = parsed.data;
        const found = USERS[username];

        if (!found || found.password !== password) {
          throw new UnauthenticatedError('Invalid username or password');
        }

        const payload = {
          sub: username,
          name: found.name,
          roles: found.roles,
        };

        const token = jwt.sign(payload, env.JWT_SECRET, {
          issuer: env.JWT_ISSUER,
          audience: env.JWT_AUDIENCE,
          expiresIn: env.JWT_EXPIRES_IN,
        });

        res.json({
          token,
          expiresIn: env.JWT_EXPIRES_IN,
          user: payload,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}