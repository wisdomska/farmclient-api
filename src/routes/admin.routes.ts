import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { asyncHandler } from '../middleware/error'
import { requireAuth, requireRole } from '../middleware/auth'
import { prisma } from '../config/prisma'
import { moolre } from '../services/moolre.service'

const router = Router()

// Apply auth + role guard to ALL admin routes
router.use(requireAuth, requireRole('admin', 'superadmin'))

// GET /admin/users?role=&q=&page=
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      role: z.enum(['farmer', 'buyer']).optional(),
      q: z.string().optional(),
      page: z.coerce.number().int().positive().optional().default(1),
    })
    const { role, q, page } = schema.parse(req.query)
    const skip = (page - 1) * 50

    const farmers =
      role === 'buyer'
        ? []
        : await prisma.farmer.findMany({
            where: q
              ? {
                  OR: [
                    { fullName: { contains: q, mode: 'insensitive' } },
                    { phoneNumber: { contains: q } },
                    { district: { contains: q, mode: 'insensitive' } },
                  ],
                }
              : undefined,
            orderBy: { createdAt: 'desc' },
            take: 50,
            skip,
          })

    const buyers =
      role === 'farmer'
        ? []
        : await prisma.buyer.findMany({
            where: q
              ? {
                  OR: [
                    { fullName: { contains: q, mode: 'insensitive' } },
                    { email: { contains: q, mode: 'insensitive' } },
                    { phoneNumber: { contains: q } },
                  ],
                }
              : undefined,
            orderBy: { createdAt: 'desc' },
            take: 50,
            skip,
          })

    res.json({ farmers, buyers })
  }),
)

// GET /admin/orders?status=&page=
router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      status: z.string().optional(),
      page: z.coerce.number().int().positive().optional().default(1),
    })
    const { status, page } = schema.parse(req.query)
    const skip = (page - 1) * 50

    const orders = await prisma.order.findMany({
      where: status ? { status: status as never } : undefined,
      include: {
        farmer: { select: { fullName: true } },
        buyer: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      skip,
    })

    res.json({ orders })
  }),
)

// GET /admin/analytics
router.get(
  '/analytics',
  asyncHandler(async (_req, res) => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const [
      totalFarmers,
      totalBuyers,
      activeListings,
      ordersToday,
      collectionsAgg,
      disbursementsAgg,
      platformFeesAgg,
      cropGroups,
    ] = await Promise.all([
      prisma.farmer.count(),
      prisma.buyer.count(),
      prisma.listing.count({ where: { status: 'active' } }),
      prisma.order.count({ where: { createdAt: { gte: today } } }),
      prisma.order.aggregate({
        where: { status: { in: ['completed', 'confirmed'] } },
        _sum: { totalPaid: true },
      }),
      prisma.transaction.aggregate({
        where: { type: 'disbursement', status: 'success' },
        _sum: { amount: true },
      }),
      prisma.order.aggregate({
        where: { status: 'completed' },
        _sum: { platformFee: true },
      }),
      prisma.order.groupBy({
        by: ['cropType'],
        _sum: { quantityKg: true },
        orderBy: { _sum: { quantityKg: 'desc' } },
        take: 5,
      }),
    ])

    const collectionsTotal = Number(collectionsAgg._sum.totalPaid ?? 0)
    const disbursementsTotal = Number(disbursementsAgg._sum.amount ?? 0)
    const platformFees = Number(platformFeesAgg._sum.platformFee ?? 0)
    const topCrops = cropGroups.map((g) => ({
      cropType: g.cropType,
      totalKg: Number(g._sum.quantityKg ?? 0),
    }))

    res.json({
      totalFarmers,
      totalBuyers,
      activeListings,
      ordersToday,
      collectionsTotal,
      disbursementsTotal,
      platformFees,
      topCrops,
    })
  }),
)

// GET /admin/sms/log?page=
router.get(
  '/sms/log',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      page: z.coerce.number().int().positive().optional().default(1),
    })
    const { page } = schema.parse(req.query)
    const skip = (page - 1) * 50

    const logs = await prisma.smsLog.findMany({
      orderBy: { sentAt: 'desc' },
      take: 50,
      skip,
    })

    res.json({ logs })
  }),
)

// POST /admin/sms/broadcast
router.post(
  '/sms/broadcast',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      message: z.string().min(1),
      recipients: z.array(z.string()).optional(),
      region: z.string().optional(),
    })
    const { message, recipients, region } = schema.parse(req.body)

    let phones: string[] = recipients ?? []

    if (region && phones.length === 0) {
      const farmers = await prisma.farmer.findMany({
        where: { region, smsOptIn: true },
        select: { phoneNumber: true },
      })
      phones = farmers.map((f) => f.phoneNumber)
    }

    const messages = phones.map((phone, i) => ({
      recipient: phone,
      message,
      ref: `broadcast-${Date.now()}-${i}`,
    }))

    await moolre.sendBulkSms(messages)

    await prisma.smsLog.createMany({
      data: messages.map((m) => ({
        recipient: m.recipient,
        message: m.message,
        templateKey: 'broadcast',
        status: 'sent' as const,
        moolreRef: m.ref,
      })),
    })

    res.json({ sent: phones.length })
  }),
)

// POST /admin/prices — override the AI price for a crop/region (SRS FR-13).
// Recorded as a price_history row with source 'admin-override'; getPrice honours
// the latest override for 24h before falling back to the AI engine.
const overrideSchema = z.object({
  crop: z.string().min(1),
  region: z.string().min(1),
  pricePerKg: z.number().positive(),
})
router.post(
  '/prices',
  asyncHandler(async (req, res) => {
    const { crop, region, pricePerKg } = overrideSchema.parse(req.body)
    const row = await prisma.priceHistory.create({
      data: { crop, region, pricePerKg: new Prisma.Decimal(pricePerKg), source: 'admin-override' },
    })
    res.status(201).json({ ok: true, override: row })
  }),
)

export default router
