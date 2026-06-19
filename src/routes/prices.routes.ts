import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, HttpError } from '../middleware/error'
import { prisma } from '../config/prisma'
import { getPrice, getRegional, getForecast } from '../services/price.service'

const router = Router()

const cropRegionSchema = z.object({
  crop: z.string().min(1),
  region: z.string().min(1),
})

// GET /prices?crop=&region=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { crop, region } = cropRegionSchema.parse(req.query)
    const result = await getPrice(crop, region)
    res.json(result)
  }),
)

// GET /prices/history?crop=&region=&days=
router.get(
  '/history',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      crop: z.string().min(1),
      region: z.string().min(1),
      days: z.coerce.number().int().positive().optional().default(30),
    })
    const { crop, region, days } = schema.parse(req.query)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const rows = await prisma.priceHistory.findMany({
      where: {
        crop: { equals: crop, mode: 'insensitive' },
        region: { equals: region, mode: 'insensitive' },
        recordedAt: { gte: since },
      },
      orderBy: { recordedAt: 'asc' },
    })
    const series = rows.map((r) => ({ date: r.recordedAt, price: Number(r.pricePerKg) }))
    res.json({ series })
  }),
)

// GET /prices/forecast?crop=&region=&days=
router.get(
  '/forecast',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      crop: z.string().min(1),
      region: z.string().min(1),
      days: z.coerce.number().int().positive().optional(),
    })
    const { crop, region, days } = schema.parse(req.query)
    const forecast = await getForecast(crop, region, days)
    res.json({ forecast })
  }),
)

// GET /prices/regional?crop=
router.get(
  '/regional',
  asyncHandler(async (req, res) => {
    const schema = z.object({ crop: z.string().min(1) })
    const { crop } = schema.parse(req.query)
    const regions = await getRegional(crop)
    res.json({ regions })
  }),
)

export default router
