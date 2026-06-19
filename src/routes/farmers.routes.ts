import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../config/prisma'
import { asyncHandler, HttpError } from '../middleware/error'
import { requireAuth } from '../middleware/auth'
import {
  isValidGhanaCard,
  isValidGhanaMomo,
  hashSensitive,
  detectNetwork,
  refs,
} from '../utils/helpers'
import { regionForDistrict } from '../config/constants'
import { scoreBreakdown } from '../services/score.service'

const router = Router()

const registerSchema = z.object({
  fullName: z.string().min(1),
  ghanaCard: z.string().min(1),
  phoneNumber: z.string().min(1),
  district: z.string().min(1),
  crops: z.array(z.string()).min(1),
  momoNumber: z.string().min(1),
  farmSizeAcres: z.number().positive().optional(),
})

const patchSchema = z.object({
  fullName: z.string().min(1).optional(),
  district: z.string().min(1).optional(),
  crops: z.array(z.string()).min(1).optional(),
  momoNumber: z.string().min(1).optional(),
  farmSizeAcres: z.number().positive().optional(),
  smsOptIn: z.boolean().optional(),
})

// POST /farmers/register
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body)

    if (!isValidGhanaCard(body.ghanaCard)) {
      throw new HttpError(400, 'Invalid Ghana Card format (expected GHA-XXXXXXXXX-X)')
    }

    if (!isValidGhanaMomo(body.momoNumber)) {
      throw new HttpError(400, 'Invalid Ghana MoMo number')
    }

    // Duplicate phone check
    const existing = await prisma.farmer.findUnique({ where: { phoneNumber: body.phoneNumber } })
    if (existing) throw new HttpError(409, 'A farmer with this phone number already exists')

    const region = regionForDistrict(body.district)
    const network = detectNetwork(body.momoNumber)
    if (!network) throw new HttpError(400, 'Unable to detect MoMo network from momoNumber')

    const ghanaCardHash = hashSensitive(body.ghanaCard)
    const ghanaCardLast = body.ghanaCard.replace(/\s/g, '').slice(-4)
    const farmvaultId = refs.farmvaultId()

    const farmer = await prisma.farmer.create({
      data: {
        farmvaultId,
        fullName: body.fullName,
        phoneNumber: body.phoneNumber,
        ghanaCardHash,
        ghanaCardLast,
        district: body.district,
        region,
        crops: body.crops,
        momoNumber: body.momoNumber,
        momoNetwork: network,
        ...(body.farmSizeAcres !== undefined
          ? { farmSizeAcres: new Prisma.Decimal(body.farmSizeAcres) }
          : {}),
        regChannel: 'app',
      },
    })

    res.status(201).json(farmer)
  }),
)

// GET /farmers/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const farmer = await prisma.farmer.findUnique({ where: { id: req.params.id } })
    if (!farmer) throw new HttpError(404, 'Farmer not found')
    res.json(farmer)
  }),
)

// PATCH /farmers/:id
router.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = patchSchema.parse(req.body)

    const updateData: Record<string, unknown> = {}

    if (body.fullName !== undefined) updateData.fullName = body.fullName
    if (body.district !== undefined) {
      updateData.district = body.district
      updateData.region = regionForDistrict(body.district)
    }
    if (body.crops !== undefined) updateData.crops = body.crops
    if (body.momoNumber !== undefined) {
      if (!isValidGhanaMomo(body.momoNumber)) throw new HttpError(400, 'Invalid Ghana MoMo number')
      const network = detectNetwork(body.momoNumber)
      if (!network) throw new HttpError(400, 'Unable to detect MoMo network from momoNumber')
      updateData.momoNumber = body.momoNumber
      updateData.momoNetwork = network
    }
    if (body.farmSizeAcres !== undefined) {
      updateData.farmSizeAcres = new Prisma.Decimal(body.farmSizeAcres)
    }
    if (body.smsOptIn !== undefined) updateData.smsOptIn = body.smsOptIn

    const farmer = await prisma.farmer.update({
      where: { id: req.params.id },
      data: updateData,
    })

    res.json(farmer)
  }),
)

// GET /farmers/:id/score
router.get(
  '/:id/score',
  asyncHandler(async (req, res) => {
    const breakdown = await scoreBreakdown(req.params.id)
    if (!breakdown) throw new HttpError(404, 'Score not found for this farmer')
    res.json(breakdown)
  }),
)

// GET /farmers/:id/stats
router.get(
  '/:id/stats',
  asyncHandler(async (req, res) => {
    const farmer = await prisma.farmer.findUnique({
      where: { id: req.params.id },
      select: { totalRevenue: true, totalOrders: true, farmScore: true },
    })
    if (!farmer) throw new HttpError(404, 'Farmer not found')

    const activeListings = await prisma.listing.count({
      where: { farmerId: req.params.id, status: 'active' },
    })

    const pendingOrders = await prisma.order.count({
      where: {
        farmerId: req.params.id,
        status: { in: ['confirmed', 'in_progress', 'delivered'] },
      },
    })

    res.json({
      totalRevenue: Number(farmer.totalRevenue),
      totalOrders: farmer.totalOrders,
      farmScore: farmer.farmScore,
      activeListings,
      pendingOrders,
    })
  }),
)

export default router
