import { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import { Role } from '../types/roles'

export interface JwtPayload {
  sub: string
  role: Role
  email?: string
  buyerId?: string
  farmerId?: string
  agentId?: string
  region?: string
}

/** Issue an internal JWT (24h default). */
export function generateJwt(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'] })
}

/** Verify the internal JWT and attach req.user. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  if (!token) return res.status(401).json({ error: 'No token' })
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as JwtPayload
    req.user = decoded
    next()
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' })
  }
}

/** Restrict a route to one or more roles. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' })
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' })
    next()
  }
}
