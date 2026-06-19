import { Request, Response, Router } from 'express'
import { asyncHandler } from '../middleware/error'
import { env } from '../config/env'
import { onCollectionSuccess, onDisbursementSuccess } from '../services/payment.service'

const router = Router()

function verifySignature(req: Request, res: Response): boolean {
  if (!env.webhookSecret) return true
  const sig = req.headers['x-moolre-signature']
  if (sig !== env.webhookSecret) {
    res.status(401).json({ error: 'Invalid webhook signature' })
    return false
  }
  return true
}

/**
 * NOTE on serverless: we AWAIT the handler before returning 200. On Vercel the
 * function is frozen once the response is sent, so fire-and-forget work would
 * never run. The processing is fast (a few DB writes + best-effort SMS) and
 * completes well within Moolre's webhook timeout.
 */

// POST /webhook/moolre/collection
router.post(
  '/moolre/collection',
  asyncHandler(async (req, res) => {
    if (!verifySignature(req, res)) return
    const { txstatus, externalref, transactionid, amount } = req.body as {
      txstatus: string | number
      externalref: string
      transactionid: string
      amount: string
    }
    if (txstatus == 1) {
      await onCollectionSuccess(externalref, transactionid, amount).catch(() => {})
    }
    res.status(200).json({ received: true })
  }),
)

// POST /webhook/moolre/disbursement
router.post(
  '/moolre/disbursement',
  asyncHandler(async (req, res) => {
    if (!verifySignature(req, res)) return
    const { txstatus, externalref, transactionid } = req.body as {
      txstatus: string | number
      externalref: string
      transactionid: string
    }
    if (txstatus == 1) {
      await onDisbursementSuccess(externalref, transactionid).catch(() => {})
    }
    res.status(200).json({ received: true })
  }),
)

export default router
