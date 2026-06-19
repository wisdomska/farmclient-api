import axios from 'axios'
import { env } from '../config/env'
import { prisma } from '../config/prisma'

export interface PriceResult {
  crop: string
  region: string
  price: number
  trend: 'up' | 'stable' | 'down'
  changePct: number
  source: 'ai' | 'cache' | 'fallback'
  updatedAt: string
}

/**
 * Price intelligence client. Calls the Python AI microservice; on failure,
 * falls back to the rolling 7-day average from our own price_history table
 * (SRS NFR: graceful degradation to last cached price).
 */
export async function getPrice(crop: string, region: string): Promise<PriceResult> {
  // 1. An admin override (set via /v1/admin/prices) wins for 24h (SRS FR-13: AI price override).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const override = await prisma.priceHistory.findFirst({
    where: {
      crop: { equals: crop, mode: 'insensitive' },
      region: { equals: region, mode: 'insensitive' },
      source: 'admin-override',
      recordedAt: { gte: since },
    },
    orderBy: { recordedAt: 'desc' },
  })
  if (override) {
    return {
      crop,
      region,
      price: Number(override.pricePerKg),
      trend: 'stable',
      changePct: 0,
      source: 'fallback',
      updatedAt: override.recordedAt.toISOString(),
    }
  }

  // 2. Otherwise ask the AI microservice.
  try {
    const { data } = await axios.get(`${env.aiServiceUrl}/price`, {
      params: { crop: crop.toLowerCase(), region: region.toLowerCase() },
      timeout: 4000,
    })
    return {
      crop,
      region,
      price: Number(data.price),
      trend: data.trend ?? 'stable',
      changePct: Number(data.change_pct ?? 0),
      source: 'ai',
      updatedAt: data.updated_at ?? new Date().toISOString(),
    }
  } catch {
    return fallbackPrice(crop, region)
  }
}

/** Rolling-average fallback computed from internal transaction/price history. */
export async function fallbackPrice(crop: string, region: string): Promise<PriceResult> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  const rows = await prisma.priceHistory.findMany({
    where: { crop: { equals: crop, mode: 'insensitive' }, region: { equals: region, mode: 'insensitive' }, recordedAt: { gte: since } },
    orderBy: { recordedAt: 'desc' },
    take: 14,
  })

  if (rows.length === 0) {
    return { crop, region, price: 0, trend: 'stable', changePct: 0, source: 'fallback', updatedAt: new Date().toISOString() }
  }

  const latest = Number(rows[0].pricePerKg)
  const recent = rows.slice(0, 7)
  const prior = rows.slice(7, 14)
  const avg = (arr: typeof rows) => (arr.length ? arr.reduce((s, r) => s + Number(r.pricePerKg), 0) / arr.length : latest)
  const recentAvg = avg(recent)
  const priorAvg = avg(prior.length ? prior : recent)
  const changePct = priorAvg ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0
  const trend: PriceResult['trend'] = changePct > 1 ? 'up' : changePct < -1 ? 'down' : 'stable'

  return {
    crop,
    region,
    price: Math.round(latest * 100) / 100,
    trend,
    changePct: Math.round(changePct * 10) / 10,
    source: 'cache',
    updatedAt: rows[0].recordedAt.toISOString(),
  }
}

/** Regional comparison for a crop. */
export async function getRegional(crop: string): Promise<{ region: string; price: number }[]> {
  try {
    const { data } = await axios.get(`${env.aiServiceUrl}/regional`, {
      params: { crop: crop.toLowerCase() },
      timeout: 4000,
    })
    return (data.regions ?? []).map((r: any) => ({ region: r.region, price: Number(r.price) }))
  } catch {
    const rows = await prisma.priceHistory.findMany({
      where: { crop: { equals: crop, mode: 'insensitive' } },
      orderBy: { recordedAt: 'desc' },
      take: 60,
    })
    const byRegion = new Map<string, number>()
    for (const r of rows) if (!byRegion.has(r.region)) byRegion.set(r.region, Number(r.pricePerKg))
    return Array.from(byRegion.entries()).map(([region, price]) => ({ region, price }))
  }
}

/** 7-day forecast (AI only; empty array on failure). */
export async function getForecast(crop: string, region: string, days = 7) {
  try {
    const { data } = await axios.get(`${env.aiServiceUrl}/forecast`, {
      params: { crop: crop.toLowerCase(), region: region.toLowerCase(), days: String(days) },
      timeout: 4000,
    })
    return data.forecast ?? []
  } catch {
    return []
  }
}
