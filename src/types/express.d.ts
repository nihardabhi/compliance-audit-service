import { Logger } from 'pino';
import { AuthUser } from '../domain/auth';

declare global {
  namespace Express {
    interface Request {
      /** Populated by requestContext middleware. */
      requestId: string;
      /** Populated by requestContext middleware — child of the root pino logger. */
      log: Logger;
      /** Populated by authenticate middleware. Undefined on public routes. */
      user?: AuthUser;
    }
  }
}