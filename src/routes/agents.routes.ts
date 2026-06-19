import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, HttpError } from '../middleware/error'
import { requireAuth, requireRole } from '../middleware/auth'
import { prisma } from '../config/prisma'

const router = Router()

// POST /agents — admin onboards a field agent (SRS: agent management).
const createSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional(),
  region: z.string().min(1),
  firebaseUid: z.string().optional(),
})
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'superadmin'),
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body)
    const agent = await prisma.agent.create({ data })
    res.status(201).json(agent)
  }),
)

// GET /agents — list field agents.
router.get(
  '/',
  requireAuth,
  requireRole('admin', 'superadmin'),
  asyncHandler(async (_req, res) => {
    const agents = await prisma.agent.findMany({ orderBy: { createdAt: 'desc' } })
    res.json({ agents })
  }),
)

// PATCH /agents/verify/:farmerId — agent or admin verifies a farmer's identity
// (SRS FR-01: field agents verify farmer identity on the ground).
router.patch(
  '/verify/:farmerId',
  requireAuth,
  requireRole('agent', 'admin', 'superadmin'),
  asyncHandler(async (req, res) => {
    const farmer = await prisma.farmer.findUnique({ where: { id: req.params.farmerId } })
    if (!farmer) throw new HttpError(404, 'Farmer not found')
    const updated = await prisma.farmer.update({
      where: { id: farmer.id },
      data: { verification: 'verified' },
    })
    res.json({ ok: true, farmer: { id: updated.id, verification: updated.verification } })
  }),
)

export default router
