import cron from 'node-cron'
import axios from 'axios'
import { prisma } from '../config/prisma'
import { env } from '../config/env'
import { getPrice } from '../services/price.service'
import { triggerPayout } from '../services/payment.service'
import { sendTemplate } from '../services/sms.service'
import { moolre } from '../services/moolre.service'
import { money } from '../utils/helpers'

const PRICE_ALERT_BATCH_CAP = 500

/**
 * Each job is an exported async function so it can be invoked by node-cron
 * (long-running hosts) OR via an HTTP endpoint (Vercel Cron / serverless).
 */

export async function runPriceAlerts() {
  const farmers = await prisma.farmer.findMany({ where: { smsOptIn: true } })
  const batch = farmers.slice(0, PRICE_ALERT_BATCH_CAP)
  let sent = 0
  let skipped = 0
  for (const farmer of batch) {
    const crop = farmer.crops[0]
    if (!crop) { skipped++; continue }
    try {
      const p = await getPrice(crop, farmer.region)
      await sendTemplate(farmer.phoneNumber, 'priceAlert', {
        crop,
        region: farmer.region,
        price: money(p.price),
        dir: p.trend === 'down' ? 'DOWN' : 'UP',
        pct: String(Math.abs(p.changePct)),
      })
      sent++
    } catch {
      skipped++
    }
  }
  return { sent, skipped, total: farmers.length, capped: farmers.length > PRICE_ALERT_BATCH_CAP }
}

export async function runExpireListings() {
  const now = new Date()
  const expiring = await prisma.listing.findMany({
    where: { status: 'active', expiresAt: { lt: now } },
    include: { farmer: true },
  })
  let expired = 0
  for (const listing of expiring) {
    try {
      await prisma.listing.update({ where: { id: listing.id }, data: { status: 'expired' } })
      await sendTemplate(listing.farmer.phoneNumber, 'listingExpiring', {
        crop: listing.cropType,
        listingRef: listing.listingRef,
      })
      expired++
    } catch {
      /* continue */
    }
  }
  return { expired }
}

export async function runAutoConfirmDeliveries() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const orders = await prisma.order.findMany({
    where: {
      buyerReceiptConfirmed: false,
      deliveryDate: { not: null, lt: cutoff },
      OR: [{ status: 'in_progress' }, { status: 'delivered', farmerDispatched: true }],
    },
  })
  let confirmed = 0
  for (const order of orders) {
    try {
      await prisma.order.update({ where: { id: order.id }, data: { buyerReceiptConfirmed: true } })
      await triggerPayout(order.id)
      confirmed++
    } catch {
      /* continue */
    }
  }
  return { confirmed }
}

export async function runRetrain() {
  try {
    const result = await axios.post(`${env.aiServiceUrl}/retrain`, {}, { timeout: 30000 })
    return { ok: true, data: result.data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function runBalanceCheck() {
  const result = await moolre.accountBalance()
  const balance = parseFloat(result.data?.balance ?? '0')
  const low = balance < 500
  if (low) console.warn(`[jobs/balanceCheck] ADMIN ALERT: Moolre balance low — GHS ${balance}`)
  return { balance, low }
}

export const JOB_TASKS: Record<string, () => Promise<unknown>> = {
  'price-alerts': runPriceAlerts,
  'expire-listings': runExpireListings,
  'auto-confirm': runAutoConfirmDeliveries,
  retrain: runRetrain,
  'balance-check': runBalanceCheck,
}

const wrap = (name: string, fn: () => Promise<unknown>) => async () => {
  try {
    const out = await fn()
    console.log(`[jobs/${name}] done`, out)
  } catch (err) {
    console.error(`[jobs/${name}] fatal:`, err)
  }
}

/** Schedule jobs with node-cron (for long-running hosts like Railway). */
export function registerJobs(): void {
  if (env.nodeEnv === 'test') return
  if (process.env.DISABLE_NODE_CRON === 'true') return // Vercel uses HTTP cron instead
  const tz = { timezone: 'UTC' as const }
  cron.schedule('0 7 * * *', wrap('priceAlerts', runPriceAlerts), tz)
  cron.schedule('0 9 * * *', wrap('expireListings', runExpireListings), tz)
  cron.schedule('0 10 * * *', wrap('autoConfirm', runAutoConfirmDeliveries), tz)
  cron.schedule('0 8 * * 0', wrap('retrain', runRetrain), tz)
  cron.schedule('0 * * * *', wrap('balanceCheck', runBalanceCheck), tz)
  console.log('[jobs] all cron jobs registered')
}
