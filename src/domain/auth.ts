/**
 * Authentication / authorization domain.
 *
 * Two roles as required by the brief:
 *  - `reader`  — may read audits and download attachments.
 *  - `editor`  — everything a reader can do, plus create/update audits and
 *                upload attachments.
 *
 * Roles are carried as a JWT claim and materialized into an AuthUser by the
 * auth middleware. Authorization decisions are centralized in `can()` so the
 * policy lives in one place.
 */
export enum Role {
  Reader = 'reader',
  Editor = 'editor',
}

export interface AuthUser {
  /** Subject — the stable user id (JWT `sub`). */
  sub: string;
  name: string;
  roles: Role[];
}

export type Permission =
  | 'audit:read'
  | 'audit:create'
  | 'audit:update'
  | 'attachment:upload'
  | 'attachment:download';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.Reader]: ['audit:read', 'attachment:download'],
  [Role.Editor]: [
    'audit:read',
    'audit:create',
    'audit:update',
    'attachment:upload',
    'attachment:download',
  ],
};

export function can(user: AuthUser, permission: Permission): boolean {
  return user.roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission));
}