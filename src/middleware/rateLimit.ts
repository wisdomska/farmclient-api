import { NextFunction, Request, Response } from 'express'
import { redis } from '../config/redis'

/**
 * Redis-backed fixed-window rate limiter (works with Upstash or the in-memory
 * dev fallback). Keyed by an arbitrary identifier extractor.
 */
export function rateLimit(opts: { windowSec: number; max: number; keyFn: (req: Request) => string; name: string }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = opts.keyFn(req) || req.ip || 'anon'
      const key = `rl:${opts.name}:${id}`
      const count = await redis.incr(key)
      if (count === 1) await redis.expire(key, opts.windowSec)
      if (count > opts.max) {
        return res.status(429).json({ error: 'Too many requests, slow down.' })
      }
    } catch {
      // Fail open — never block traffic on limiter errors.
    }
    next()
  }
}

/** POST /ussd — max 100 req/min per sessionId. */
export const ussdRateLimit = rateLimit({
  name: 'ussd',
  windowSec: 60,
  max: 100,
  keyFn: (req) => req.body?.sessionId ?? req.ip ?? 'anon',
})

/** POST /payments/* — max 10 req/min per user. */
export const paymentsRateLimit = rateLimit({
  name: 'payments',
  windowSec: 60,
  max: 10,
  keyFn: (req) => req.user?.sub ?? req.ip ?? 'anon',
})
