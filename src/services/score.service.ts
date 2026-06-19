import { prisma } from '../config/prisma'

export interface ScoreInputs {
  completedOrders: number
  onTimeRate: number // 0..1
  avgRating: number // 0..5
  listingAccuracy: number // 0..1
  monthsActive: number
  totalRevenue: number
}

/**
 * FarmScore (0–1000) — AI credit/reliability score (SRS §FR-10.1).
 * Implements the weighted formula from the build spec, clamped to [0, 1000].
 */
export function computeFarmScore(i: ScoreInputs): number {
  const raw =
    (i.completedOrders * 0.25 +
      i.onTimeRate * 200 +
      i.avgRating * 40 +
      i.listingAccuracy * 150 +
      i.monthsActive * 10 +
      Math.min(i.totalRevenue / 100, 100)) *
    10
  return Math.max(0, Math.min(1000, Math.round(raw)))
}

/** Months between a date and now (fractional). */
function monthsSince(d: Date): number {
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30)
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Derive the live FarmScore inputs from the farmer's order history.
 * - avgRating: mean of buyer-given farmerRating across rated orders
 * - onTimeRate: completed orders delivered on/before deliveryDate (+1d grace)
 * - listingAccuracy: 1 − (disputed / total) orders
 */
async function deriveInputs(farmerId: string): Promise<ScoreInputs> {
  const farmer = await prisma.farmer.findUnique({ where: { id: farmerId } })
  const orders = await prisma.order.findMany({ where: { farmerId } })

  const rated = orders.filter((o) => o.farmerRating != null)
  const avgRating = rated.length ? rated.reduce((s, o) => s + (o.farmerRating ?? 0), 0) / rated.length : 0

  const completed = orders.filter((o) => o.status === 'completed')
  const withDate = completed.filter((o) => o.deliveryDate && o.completedAt)
  const onTime = withDate.filter((o) => o.completedAt!.getTime() <= o.deliveryDate!.getTime() + DAY)
  const onTimeRate = withDate.length ? onTime.length / withDate.length : 1

  const disputed = orders.filter((o) => o.status === 'disputed').length
  const listingAccuracy = orders.length ? Math.max(0, 1 - disputed / orders.length) : 1

  return {
    completedOrders: completed.length,
    onTimeRate,
    avgRating,
    listingAccuracy,
    monthsActive: farmer ? monthsSince(farmer.createdAt) : 0,
    totalRevenue: farmer ? Number(farmer.totalRevenue) : 0,
  }
}

/**
 * Recalculate and persist a farmer's FarmScore. Also caches the derived
 * sub-metrics (onTimeRate, listingAccuracy, ratingSum/Count) on the farmer row
 * so the USSD/app wallet views can show a breakdown cheaply.
 */
export async function recalcFarmScore(farmerId: string): Promise<number> {
  const farmer = await prisma.farmer.findUnique({ where: { id: farmerId } })
  if (!farmer) return 0

  const inputs = await deriveInputs(farmerId)
  const score = computeFarmScore(inputs)

  const rated = await prisma.order.findMany({
    where: { farmerId, farmerRating: { not: null } },
    select: { farmerRating: true },
  })
  const ratingSum = rated.reduce((s, o) => s + (o.farmerRating ?? 0), 0)

  await prisma.farmer.update({
    where: { id: farmerId },
    data: {
      farmScore: score,
      onTimeRate: inputs.onTimeRate,
      listingAccuracy: inputs.listingAccuracy,
      ratingSum,
      ratingCount: rated.length,
    },
  })
  return score
}

/** Score breakdown for UI/USSD display. */
export async function scoreBreakdown(farmerId: string) {
  const farmer = await prisma.farmer.findUnique({ where: { id: farmerId } })
  if (!farmer) return null
  const inputs = await deriveInputs(farmerId)
  return {
    score: farmer.farmScore,
    completedOrders: inputs.completedOrders,
    onTimeRate: Math.round(inputs.onTimeRate * 100) / 100,
    avgRating: Math.round(inputs.avgRating * 10) / 10,
    listingAccuracy: Math.round(inputs.listingAccuracy * 100) / 100,
    monthsActive: Math.round(inputs.monthsActive),
    totalRevenue: inputs.totalRevenue,
  }
}
