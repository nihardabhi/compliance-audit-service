/**
 * Authentication / authorization domain.
 *
 * Two roles:
 *  - `user`  — may read audits and download attachments.
 *  - `admin` — everything a user can do, plus create/update audits and
 *              upload attachments.
 */
export enum Role {
  User  = 'user',
  Admin = 'admin',
}

export interface AuthUser {
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
  [Role.User]: ['audit:read', 'attachment:download'],
  [Role.Admin]: [
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