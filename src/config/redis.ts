import { Redis } from '@upstash/redis'
import { env } from './env'

/**
 * Upstash Redis (REST) — serverless-friendly. Used for USSD session state,
 * price cache and rate-limit counters.
 *
 * If REDIS_URL/TOKEN are not configured (e.g. local dev without Upstash), we
 * fall back to an in-memory store so the app still boots. The in-memory store
 * is per-process and NOT suitable for production (USSD sessions must be shared).
 */
interface KV {
  get<T = unknown>(key: string): Promise<T | null>
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>
  del(key: string): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

class MemoryKV implements KV {
  private store = new Map<string, { value: unknown; expiresAt?: number }>()

  private alive(key: string) {
    const e = this.store.get(key)
    if (!e) return undefined
    if (e.expiresAt && e.expiresAt < Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return e
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const e = this.alive(key)
    return e ? (e.value as T) : null
  }

  async set(key: string, value: unknown, opts?: { ex?: number }) {
    this.store.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : undefined })
    return 'OK'
  }

  async del(key: string) {
    this.store.delete(key)
    return 1
  }

  async incr(key: string): Promise<number> {
    const e = this.alive(key)
    const next = ((e?.value as number) ?? 0) + 1
    this.store.set(key, { value: next, expiresAt: e?.expiresAt })
    return next
  }

  async expire(key: string, seconds: number) {
    const e = this.store.get(key)
    if (e) e.expiresAt = Date.now() + seconds * 1000
    return 1
  }
}

let client: KV

if (env.redis.url && env.redis.token) {
  client = new Redis({ url: env.redis.url, token: env.redis.token }) as unknown as KV
} else {
  // No Upstash configured. Fall back to in-memory KV so the API still boots.
  // NOTE: in-memory state is per-instance — fine for the buyer web flow and
  // dev, but USSD sessions + rate limiting need Upstash in production (serverless
  // instances don't share memory). Set REDIS_URL/REDIS_TOKEN to enable it.
  // eslint-disable-next-line no-console
  console.warn('[redis] no Upstash credentials — using in-memory KV (USSD/rate-limit not shared across instances)')
  client = new MemoryKV()
}

export const redis = client
