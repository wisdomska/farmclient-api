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
 * Moolre's webhook envelope is { status, code, message, data: {…} } where the
 * transaction fields live inside `data`. We read from `data` first and fall
 * back to the top level so we tolerate both the documented shape and the
 * flatter shape from the original spec.
 */
function parseMoolre(body: any) {
  const data = body?.data ?? body ?? {}
  const txstatus = data.txstatus ?? body?.txstatus ?? data.status ?? body?.status
  return {
    success: Number(txstatus) === 1,
    externalref: data.externalref ?? body?.externalref,
    transactionid: data.transactionid ?? data.txid ?? body?.transactionid,
    amount: data.amount ?? body?.amount,
  }
}

/**
 * AWAIT processing before returning 200 — on Vercel the function freezes once
 * the response is sent, so fire-and-forget work would never run. The work is
 * fast and completes within Moolre's webhook timeout.
 */

// POST /webhook/moolre/collection
router.post(
  '/moolre/collection',
  asyncHandler(async (req, res) => {
    if (!verifySignature(req, res)) return
    const { success, externalref, transactionid, amount } = parseMoolre(req.body)
    if (success && externalref) {
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
    const { success, externalref, transactionid } = parseMoolre(req.body)
    if (success && externalref) {
      await onDisbursementSuccess(externalref, transactionid).catch(() => {})
    }
    res.status(200).json({ received: true })
  }),
)

export default router
