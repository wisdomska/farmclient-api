import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, HttpError } from '../middleware/error'
import { requireAuth, generateJwt } from '../middleware/auth'
import { googleSignIn, phoneSignIn, registerWithEmail, loginWithEmail } from '../services/auth.service'

const router = Router()

const idTokenSchema = z.object({
  idToken: z.string().min(1),
})

const phoneSchema = z.object({
  phoneNumber: z.string().min(1),
})

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(1),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// POST /auth/register — email + password (buyer)
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { email, password, fullName } = registerSchema.parse(req.body)
    const result = await registerWithEmail(email, password, fullName)
    res.status(201).json(result)
  }),
)

// POST /auth/login — email + password
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body)
    const result = await loginWithEmail(email, password)
    res.json(result)
  }),
)

// POST /auth/google
router.post(
  '/google',
  asyncHandler(async (req, res) => {
    const { idToken } = idTokenSchema.parse(req.body)
    const result = await googleSignIn(idToken)
    res.json(result)
  }),
)

// POST /auth/verify  — phone OTP verification via Firebase idToken
router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const { idToken } = idTokenSchema.parse(req.body)
    const result = await phoneSignIn(idToken)
    res.json(result)
  }),
)

// POST /auth/phone  — client-side OTP request hint
router.post(
  '/phone',
  asyncHandler(async (req, res) => {
    phoneSchema.parse(req.body)
    res.status(202).json({
      ok: true,
      message: 'Use Firebase client SDK to request the OTP, then POST /auth/verify with the idToken.',
    })
  }),
)

// POST /auth/refresh — re-issue JWT for the authenticated user
router.post(
  '/refresh',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user
    if (!user) throw new HttpError(401, 'Unauthenticated')
    const token = generateJwt({
      sub: user.sub,
      role: user.role,
      ...(user.email ? { email: user.email } : {}),
      ...(user.buyerId ? { buyerId: user.buyerId } : {}),
      ...(user.farmerId ? { farmerId: user.farmerId } : {}),
      ...(user.agentId ? { agentId: user.agentId } : {}),
      ...(user.region ? { region: user.region } : {}),
    })
    res.json({ token })
  }),
)

export default router
