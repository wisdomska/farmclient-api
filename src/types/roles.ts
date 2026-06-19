/**
 * Application roles. Kept as a TS union (not a Prisma enum) because roles live
 * in the JWT, not in a DB column — Prisma only emits enums referenced by a model.
 */
export type Role = 'farmer' | 'buyer' | 'agent' | 'admin' | 'superadmin'

export const ROLES: Role[] = ['farmer', 'buyer', 'agent', 'admin', 'superadmin']
