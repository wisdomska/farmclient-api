import { Router } from 'express'
import { asyncHandler, HttpError } from '../middleware/error'
import { JOB_TASKS } from '../jobs'
import { env } from '../config/env'

const router = Router()

/**
 * HTTP-triggerable cron tasks (for Vercel Cron / serverless, where node-cron
 * cannot run). Guarded by CRON_SECRET — Vercel Cron sends
 * `Authorization: Bearer ${CRON_SECRET}` automatically.
 */
function authorized(req: { headers: Record<string, unknown> }): boolean {
  const secret = process.env.CRON_SECRET || env.webhookSecret
  if (!secret) return env.nodeEnv !== 'production' // open in dev only
  const header = String(req.headers['authorization'] ?? '')
  return header === `Bearer ${secret}`
}

const handler = asyncHandler(async (req, res) => {
  if (!authorized(req)) throw new HttpError(401, 'Unauthorized')
  const task = req.params.task
  const fn = JOB_TASKS[task]
  if (!fn) throw new HttpError(404, `Unknown task: ${task}`)
  const result = await fn()
  res.json({ task, result })
})

// Vercel Cron issues GET requests; allow POST too for manual triggering.
router.get('/:task', handler)
router.post('/:task', handler)

export default router
