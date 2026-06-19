import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../config/prisma'
import { asyncHandler, HttpError } from '../middleware/error'
import { requireAuth, requireRole } from '../middleware/auth'
import { refs } from '../utils/helpers'
import { getPrice } from '../services/price.service'

const router = Router()

/** Parse DD/MM/YYYY or ISO date string → Date. */
function parseHarvestDate(raw: string): Date {
  const ddmmyyyy = /^(\d{2})(\d{2})(\d{4})$/.exec(raw)
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy
    return new Date(`${yyyy}-${mm}-${dd}`)
  }
  const d = new Date(raw)
  if (isNaN(d.getTime())) throw new HttpError(400, 'Invalid harvestDate format (use ISO or DDMMYYYY)')
  return d
}

const createSchema = z.object({
  cropType: z.string().min(1),
  quantityKg: z.number().positive(),
  pricePerKg: z.number().nonnegative().optional(),
  harvestDate: z.string().min(1),
  storage: z.enum(['field_fresh', 'stored', 'processed']).optional(),
  deliveryMethod: z.enum(['buyer_collects', 'farmer_delivers', 'agent']).optional(),
  photos: z.array(z.string()).optional(),
})

const patchSchema = z.object({
  pricePerKg: z.number().positive().optional(),
  quantityKg: z.number().positive().optional(),
  qtyRemaining: z.number().nonnegative().optional(),
  status: z.enum(['active', 'reserved', 'partial', 'sold', 'expired', 'cancelled']).optional(),
  photos: z.array(z.string()).optional(),
})

// POST /listings
router.post(
  '/',
  requireAuth,
  requireRole('farmer'),
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body)
    const farmerId = req.user!.farmerId
    if (!farmerId) throw new HttpError(400, 'Authenticated user has no farmerId')

    const farmer = await prisma.farmer.findUnique({
      where: { id: farmerId },
      select: { district: true, region: true },
    })
    if (!farmer) throw new HttpError(404, 'Farmer profile not found')

    const harvestDate = parseHarvestDate(body.harvestDate)
    const expiresAt = new Date(harvestDate.getTime() + 14 * 24 * 60 * 60 * 1000)
    const listingRef = refs.listing()

    let pricePerKg = body.pricePerKg ?? 0
    let aiPrice: number | undefined

    if (!pricePerKg) {
      const priceData = await getPrice(body.cropType, farmer.region)
      pricePerKg = Number(priceData.price)
      aiPrice = pricePerKg
    }

    const listing = await prisma.listing.create({
      data: {
        listingRef,
        farmerId,
        cropType: body.cropType,
        quantityKg: new Prisma.Decimal(body.quantityKg),
        qtyRemaining: new Prisma.Decimal(body.quantityKg),
        pricePerKg: new Prisma.Decimal(pricePerKg),
        ...(aiPrice !== undefined ? { aiPrice: new Prisma.Decimal(aiPrice) } : {}),
        harvestDate,
        district: farmer.district,
        region: farmer.region,
        photos: body.photos ?? [],
        ...(body.storage ? { storage: body.storage } : {}),
        ...(body.deliveryMethod ? { deliveryMethod: body.deliveryMethod } : {}),
        status: 'active',
        channel: 'app',
        expiresAt,
      },
    })

    res.status(201).json(listing)
  }),
)

// GET /listings
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const {
      crop,
      region,
      minPrice,
      maxPrice,
      verified,
      status,
      sort = 'newest',
      page = '1',
      pageSize = '20',
    } = req.query as Record<string, string | undefined>

    const pageNum = Math.max(1, parseInt(page ?? '1', 10))
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize ?? '20', 10)))
    const skip = (pageNum - 1) * pageSizeNum

    // Default marketplace view = listings that still have stock (active OR
    // partially sold). An explicit ?status= filter overrides this.
    const where: Prisma.ListingWhereInput = status
      ? { status: status as Prisma.ListingWhereInput['status'] }
      : { status: { in: ['active', 'partial'] } }

    if (crop) where.cropType = { contains: crop, mode: 'insensitive' }
    if (region) where.region = { contains: region, mode: 'insensitive' }
    if (minPrice || maxPrice) {
      where.pricePerKg = {}
      if (minPrice) where.pricePerKg.gte = new Prisma.Decimal(parseFloat(minPrice))
      if (maxPrice) where.pricePerKg.lte = new Prisma.Decimal(parseFloat(maxPrice))
    }
    if (verified === 'true') {
      where.farmer = { verification: 'verified' }
    }

    let orderBy: Prisma.ListingOrderByWithRelationInput
    switch (sort) {
      case 'price-asc':
        orderBy = { pricePerKg: 'asc' }
        break
      case 'price-desc':
        orderBy = { pricePerKg: 'desc' }
        break
      case 'rating':
        orderBy = { farmer: { farmScore: 'desc' } }
        break
      case 'newest':
      default:
        orderBy = { createdAt: 'desc' }
    }

    const [items, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        orderBy,
        skip,
        take: pageSizeNum,
        include: {
          farmer: {
            select: {
              fullName: true,
              farmScore: true,
              verification: true,
              ratingSum: true,
              ratingCount: true,
              region: true,
              district: true,
            },
          },
        },
      }),
      prisma.listing.count({ where }),
    ])

    res.json({ items, page: pageNum, total })
  }),
)

// GET /listings/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.id },
      include: {
        farmer: {
          select: {
            fullName: true,
            farmScore: true,
            verification: true,
            ratingSum: true,
            ratingCount: true,
            region: true,
            district: true,
          },
        },
      },
    })
    if (!listing) throw new HttpError(404, 'Listing not found')
    res.json(listing)
  }),
)

// PATCH /listings/:id
router.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = patchSchema.parse(req.body)

    const listing = await prisma.listing.findUnique({ where: { id: req.params.id } })
    if (!listing) throw new HttpError(404, 'Listing not found')

    // Owner check: authenticated user must be the farmer who owns this listing
    if (req.user!.farmerId !== listing.farmerId) {
      throw new HttpError(403, 'Forbidden: you do not own this listing')
    }

    const updateData: Record<string, unknown> = {}
    if (body.pricePerKg !== undefined) updateData.pricePerKg = new Prisma.Decimal(body.pricePerKg)
    if (body.quantityKg !== undefined) updateData.quantityKg = new Prisma.Decimal(body.quantityKg)
    if (body.qtyRemaining !== undefined) updateData.qtyRemaining = new Prisma.Decimal(body.qtyRemaining)
    if (body.status !== undefined) updateData.status = body.status
    if (body.photos !== undefined) updateData.photos = body.photos

    const updated = await prisma.listing.update({
      where: { id: req.params.id },
      data: updateData,
    })

    res.json(updated)
  }),
)

// DELETE /listings/:id  — soft delete (set status to cancelled)
router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const listing = await prisma.listing.findUnique({ where: { id: req.params.id } })
    if (!listing) throw new HttpError(404, 'Listing not found')

    if (req.user!.farmerId !== listing.farmerId) {
      throw new HttpError(403, 'Forbidden: you do not own this listing')
    }

    await prisma.listing.update({
      where: { id: req.params.id },
      data: { status: 'cancelled' },
    })

    res.status(204).send()
  }),
)

export default router
