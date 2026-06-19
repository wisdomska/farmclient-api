import bcrypt from 'bcryptjs'
import { prisma } from '../config/prisma'
import { Role } from '../types/roles'
import { getFirebaseAuth } from '../config/firebase'
import { env } from '../config/env'
import { generateJwt } from '../middleware/auth'
import { HttpError } from '../middleware/error'

export interface AuthResult {
  token: string
  user: unknown
  role: Role
  isNewUser: boolean
}

/** Email + password registration for buyers (production-grade, bcrypt). */
export async function registerWithEmail(email: string, password: string, fullName: string): Promise<AuthResult> {
  const e = email.trim().toLowerCase()
  const existing = await prisma.buyer.findUnique({ where: { email: e } })
  if (existing) throw new HttpError(409, 'An account with this email already exists')
  const passwordHash = await bcrypt.hash(password, 10)
  const buyer = await prisma.buyer.create({ data: { email: e, passwordHash, fullName } })
  const token = generateJwt({ sub: buyer.id, role: 'buyer', email: e, buyerId: buyer.id })
  return { token, user: sanitizeBuyer(buyer), role: 'buyer', isNewUser: true }
}

/** Email + password login. */
export async function loginWithEmail(email: string, password: string): Promise<AuthResult> {
  const e = email.trim().toLowerCase()
  const buyer = await prisma.buyer.findUnique({ where: { email: e } })
  if (!buyer || !buyer.passwordHash) throw new HttpError(401, 'Invalid email or password')
  const ok = await bcrypt.compare(password, buyer.passwordHash)
  if (!ok) throw new HttpError(401, 'Invalid email or password')
  const role: Role = env.adminEmails.includes(e) ? 'admin' : 'buyer'
  const token = generateJwt({ sub: buyer.id, role, email: e, buyerId: buyer.id })
  return { token, user: sanitizeBuyer(buyer), role, isNewUser: false }
}

function sanitizeBuyer<T extends { passwordHash?: string | null }>(b: T) {
  const { passwordHash, ...rest } = b
  return rest
}

/**
 * Verify a Firebase Google ID token and find-or-create the buyer (or agent /
 * admin if the email is allow-listed). Returns an internal JWT.
 */
export async function googleSignIn(idToken: string): Promise<AuthResult> {
  const auth = getFirebaseAuth()
  if (!auth) throw new Error('Firebase not configured')
  const decoded = await auth.verifyIdToken(idToken)
  const email = (decoded.email ?? '').toLowerCase()
  const name = decoded.name ?? decoded.email ?? 'FarmClient User'

  // Admins are allow-listed by email.
  if (email && env.adminEmails.includes(email)) {
    const token = generateJwt({ sub: decoded.uid, role: 'admin', email })
    return { token, user: { uid: decoded.uid, email, name }, role: 'admin', isNewUser: false }
  }

  let buyer = await prisma.buyer.findUnique({ where: { firebaseUid: decoded.uid } })
  const isNewUser = !buyer
  if (!buyer) {
    buyer = await prisma.buyer.create({
      data: { firebaseUid: decoded.uid, fullName: name, email: decoded.email ?? null },
    })
  }
  const token = generateJwt({ sub: buyer.id, role: 'buyer', email: buyer.email ?? undefined, buyerId: buyer.id })
  return { token, user: buyer, role: 'buyer', isNewUser }
}

/**
 * Verify a Firebase phone-OTP token (farmer app fallback) → find-or-create
 * farmer by phone, issue JWT. The farmer must already exist (registered via
 * USSD or app onboarding) to log in; otherwise isNewUser=true with no farmer.
 */
export async function phoneSignIn(idToken: string): Promise<AuthResult> {
  const auth = getFirebaseAuth()
  if (!auth) throw new Error('Firebase not configured')
  const decoded = await auth.verifyIdToken(idToken)
  const phone = decoded.phone_number ?? ''
  const local = phone.startsWith('+233') ? '0' + phone.slice(4) : phone
  const farmer = await prisma.farmer.findUnique({ where: { phoneNumber: local } })
  if (!farmer) {
    // No farmer yet — caller should route to onboarding.
    const token = generateJwt({ sub: decoded.uid, role: 'farmer' })
    return { token, user: { uid: decoded.uid, phone: local }, role: 'farmer', isNewUser: true }
  }
  if (!farmer.firebaseUid) {
    await prisma.farmer.update({ where: { id: farmer.id }, data: { firebaseUid: decoded.uid } })
  }
  const token = generateJwt({ sub: farmer.id, role: 'farmer', farmerId: farmer.id })
  return { token, user: farmer, role: 'farmer', isNewUser: false }
}
