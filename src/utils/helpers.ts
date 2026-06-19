import crypto from 'crypto'
import { MomoNetwork } from '@prisma/client'
import { NETWORK_PREFIXES } from '../config/constants'

/**
 * Normalise a Ghanaian phone number to local 0XXXXXXXXX format.
 * Accepts +233XXXXXXXXX, 233XXXXXXXXX, 0XXXXXXXXX, or 9-digit forms.
 */
export function normalizePhone(input: string): string {
  let p = (input || '').replace(/[\s\-()]/g, '')
  if (p.startsWith('+233')) p = '0' + p.slice(4)
  else if (p.startsWith('233')) p = '0' + p.slice(3)
  else if (p.length === 9 && !p.startsWith('0')) p = '0' + p
  return p
}

/** Detect the MoMo network from a phone number's prefix. */
export function detectNetwork(phone: string): MomoNetwork | null {
  const p = normalizePhone(phone)
  const prefix = p.slice(0, 3)
  return NETWORK_PREFIXES[prefix] ?? null
}

const VALID_PREFIXES = Object.keys(NETWORK_PREFIXES)

export function isValidGhanaMomo(phone: string): boolean {
  const p = normalizePhone(phone)
  return /^0\d{9}$/.test(p) && VALID_PREFIXES.includes(p.slice(0, 3))
}

/** Ghana Card format: GHA-XXXXXXXXX-X */
export function isValidGhanaCard(card: string): boolean {
  return /^GHA-\d{9}-\d$/.test((card || '').trim().toUpperCase())
}

/** SHA-256 hash (Ghana Card stored hashed per Act 843). */
export function hashSensitive(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toUpperCase()).digest('hex')
}

/** Human-readable reference generators. */
function randDigits(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10).toString()
  return s
}

export const refs = {
  farmvaultId: () => `FV-${randDigits(5)}`,
  listing: () => `HV-${randDigits(5)}`,
  order: () => `ORD-${randDigits(5)}`,
  deliveryPin: () => randDigits(6),
}

/** Sleep helper. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Retry an async fn with exponential backoff (1s, 2s, 4s). Used for Moolre calls.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await sleep(baseDelayMs * 2 ** i)
    }
  }
  throw lastErr
}

/** Round to 2 dp and return as a string (Moolre expects string amounts). */
export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2)
}

/** Strip HTML tags and ASCII control characters from USSD/user input. */
export function sanitizeInput(s: string): string {
  const noTags = (s || '').replace(/<[^>]*>/g, '')
  let out = ''
  for (const ch of noTags) {
    const code = ch.charCodeAt(0)
    if (code >= 32) out += ch // keep printable chars, drop control chars
  }
  return out.trim()
}
