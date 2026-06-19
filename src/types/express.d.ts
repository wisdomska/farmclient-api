import 'express'
import { Role } from './roles'

declare global {
  namespace Express {
    interface UserClaims {
      sub: string // internal user id (buyer/farmer/agent/admin)
      role: Role
      email?: string
      buyerId?: string
      farmerId?: string
      agentId?: string
      region?: string
    }
    interface Request {
      user?: UserClaims
    }
  }
}

export {}
