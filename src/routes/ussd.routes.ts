import { Router } from 'express'
import { asyncHandler } from '../middleware/error'
import { ussdRateLimit } from '../middleware/rateLimit'
import { handleUssd } from '../services/ussd.service'

const router = Router()

// POST /ussd
router.post(
  '/',
  ussdRateLimit,
  asyncHandler(async (req, res) => {
    const { sessionId, serviceCode, phoneNumber, text } = req.body as {
      sessionId: string
      serviceCode: string
      phoneNumber: string
      text?: string
    }
    const out = await handleUssd(sessionId, phoneNumber, text ?? '')
    res.set('Content-Type', 'text/plain').send(out)
  }),
)

export default router
