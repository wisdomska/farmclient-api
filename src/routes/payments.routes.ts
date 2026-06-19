import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/error'
import { requireAuth, requireRole } from '../middleware/auth'
import { paymentsRateLimit } from '../middleware/rateLimit'
import { initiateEscrow, triggerPayout, createPaymentLinkFor } from '../services/payment.service'
import { moolre } from '../services/moolre.service'

const router = Router()

const orderIdSchema = z.object({
  orderId: z.string().min(1),
})

// POST /payments/initiate
router.post(
  '/initiate',
  requireAuth,
  paymentsRateLimit,
  asyncHandler(async (req, res) => {
    const { orderId } = orderIdSchema.parse(req.body)
    const result = await initiateEscrow(orderId)
    res.json(result)
  }),
)

// POST /payments/payout — admin/superadmin only
router.post(
  '/payout',
  requireAuth,
  requireRole('admin', 'superadmin'),
  asyncHandler(async (req, res) => {
    const { orderId } = orderIdSchema.parse(req.body)
    const result = await triggerPayout(orderId)
    res.json(result)
  }),
)

// GET /payments/:ref/status
router.get(
  '/:ref/status',
  asyncHandler(async (req, res) => {
    const result = await moolre.checkStatus(req.params.ref)
    res.json(result)
  }),
)

// POST /payments/link
router.post(
  '/link',
  requireAuth,
  paymentsRateLimit,
  asyncHandler(async (req, res) => {
    const { orderId } = orderIdSchema.parse(req.body)
    const result = await createPaymentLinkFor(orderId)
    res.json({ authorization_url: result.data?.authorization_url, result })
  }),
)

export default router
