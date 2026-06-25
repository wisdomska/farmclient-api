import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { asyncHandler, HttpError } from '../middleware/error'
import { requireAuth, requireRole } from '../middleware/auth'
import { prisma } from '../config/prisma'
import { refs, normalizePhone, isValidGhanaMomo } from '../utils/helpers'
import { env } from '../config/env'
import { initiateEscrow, triggerPayout } from '../services/payment.service'
import { sendTemplate } from '../services/sms.service'
import { recalcFarmScore } from '../services/score.service'

const router = Router()

const placeOrderSchema = z.object({
  listingId: z.string().min(1),
  quantityKg: z.number().positive(),
  deliveryDate: z.string().datetime({ offset: true }).optional(),
  deliveryMethod: z.enum(['buyer_collects', 'farmer_delivers', 'agent']).optional(),
  // Buyer's mobile-money number — the Moolre collection prompt is sent here.
  payerPhone: z.string().optional(),
})

const receiveSchema = z.object({
  pin: z.string().optional(),
})

const disputeSchema = z.object({
  reason: z.string().optional(),
})

// POST / — place an order
router.post(
  '/',
  requireAuth,
  requireRole('buyer'),
  asyncHandler(async (req, res) => {
    const body = placeOrderSchema.parse(req.body)

    const listing = await prisma.listing.findUnique({ where: { id: body.listingId } })
    if (!listing) throw new HttpError(404, 'Listing not found')

    if (body.quantityKg > Number(listing.qtyRemaining)) {
      throw new HttpError(400, `Requested quantity exceeds available stock (${Number(listing.qtyRemaining)} kg remaining)`)
    }

    const subtotal = body.quantityKg * Number(listing.pricePerKg)
    const platformFee = subtotal * (env.platformFeePercent / 100)
    const totalPaid = subtotal + platformFee

    const newQtyRemaining = Number(listing.qtyRemaining) - body.quantityKg
    const newListingStatus = newQtyRemaining <= 0 ? 'sold' : 'partial'

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderRef: refs.order(),
          listingId: body.listingId,
          farmerId: listing.farmerId,
          buyerId: req.user!.buyerId!,
          cropType: listing.cropType,
          quantityKg: new Prisma.Decimal(body.quantityKg),
          pricePerKg: listing.pricePerKg,
          subtotal: new Prisma.Decimal(subtotal),
          platformFee: new Prisma.Decimal(platformFee),
          totalPaid: new Prisma.Decimal(totalPaid),
          status: 'pending_payment',
          ...(body.deliveryDate ? { deliveryDate: new Date(body.deliveryDate) } : {}),
          ...(body.deliveryMethod ? { deliveryMethod: body.deliveryMethod } : {}),
        },
      })

      await tx.listing.update({
        where: { id: body.listingId },
        data: {
          qtyRemaining: new Prisma.Decimal(newQtyRemaining),
          status: newListingStatus,
        },
      })

      return created
    })

    // Set the buyer's MoMo number so Moolre sends the payment prompt there.
    if (body.payerPhone) {
      const payer = normalizePhone(body.payerPhone)
      if (!isValidGhanaMomo(payer)) throw new HttpError(400, 'Invalid mobile money number')
      await prisma.buyer.update({ where: { id: req.user!.buyerId! }, data: { phoneNumber: payer } })
    }

    const payment = await initiateEscrow(order.id)

    res.status(201).json({ order, payment })
  }),
)

// GET / — the authenticated buyer's orders (split ongoing / past)
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const buyerId = req.user?.buyerId
    if (!buyerId) throw new HttpError(403, 'Buyer account required')
    const orders = await prisma.order.findMany({
      where: { buyerId },
      orderBy: { createdAt: 'desc' },
      include: { farmer: { select: { fullName: true, region: true, district: true } } },
    })
    const ongoing = orders.filter((o) => ['pending_payment', 'confirmed', 'in_progress', 'delivered'].includes(o.status))
    const past = orders.filter((o) => ['completed', 'cancelled', 'disputed'].includes(o.status))
    res.json({ ongoing, past, total: orders.length })
  }),
)

// GET /:id — order detail
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        farmer: {
          select: {
            fullName: true,
            momoNumber: true,
            region: true,
          },
        },
        buyer: true,
        listing: true,
      },
    })
    if (!order) throw new HttpError(404, 'Order not found')
    res.json(order)
  }),
)

// PATCH /:id/confirm — farmer confirms order
router.patch(
  '/:id/confirm',
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { buyer: true },
    })
    if (!existing) throw new HttpError(404, 'Order not found')

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { status: 'in_progress' },
      include: { buyer: true, farmer: true },
    })

    if (order.buyer?.phoneNumber) {
      sendTemplate(order.buyer.phoneNumber, 'orderConfirmed', {
        farmerName: order.farmer.fullName,
        orderRef: order.orderRef,
        qty: String(order.quantityKg),
        crop: order.cropType,
        date: order.deliveryDate ? order.deliveryDate.toISOString().slice(0, 10) : 'soon',
      }).catch(() => {})
    }

    res.json(order)
  }),
)

// PATCH /:id/deliver — farmer marks dispatched
router.patch(
  '/:id/deliver',
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await prisma.order.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Order not found')

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { farmerDispatched: true, status: 'delivered' },
    })

    res.json(order)
  }),
)

// PATCH /:id/receive — buyer confirms receipt
router.patch(
  '/:id/receive',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = receiveSchema.parse(req.body)

    const existing = await prisma.order.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Order not found')

    if (existing.deliveryPin) {
      if (!body.pin || body.pin !== existing.deliveryPin) {
        throw new HttpError(400, 'Invalid or missing delivery PIN')
      }
    }

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { buyerReceiptConfirmed: true, status: 'delivered' },
    })

    const payout = await triggerPayout(order.id)

    res.json({ order, payout })
  }),
)

// PATCH /:id/dispute — raise a dispute
router.patch(
  '/:id/dispute',
  requireAuth,
  asyncHandler(async (req, res) => {
    disputeSchema.parse(req.body)

    const existing = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { farmer: true, buyer: true },
    })
    if (!existing) throw new HttpError(404, 'Order not found')

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { status: 'disputed' },
      include: { farmer: true, buyer: true },
    })

    const vars = { orderRef: order.orderRef }
    if (order.farmer?.phoneNumber) {
      sendTemplate(order.farmer.phoneNumber, 'disputeRaised', vars).catch(() => {})
    }
    if (order.buyer?.phoneNumber) {
      sendTemplate(order.buyer.phoneNumber, 'disputeRaised', vars).catch(() => {})
    }

    res.json(order)
  }),
)

// PATCH /:id/rate — submit a rating after completion.
//   buyer rates the farmer (updates farmerRating → recalculates FarmScore)
//   farmer rates the buyer (updates buyerRating)
const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  by: z.enum(['buyer', 'farmer']).optional(),
})
router.patch(
  '/:id/rate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rating, by } = rateSchema.parse(req.body)
    const existing = await prisma.order.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Order not found')

    // Infer who is rating from the JWT role unless explicitly provided.
    const rater = by ?? (req.user?.role === 'farmer' ? 'farmer' : 'buyer')

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: rater === 'buyer' ? { farmerRating: rating } : { buyerRating: rating },
    })

    // A buyer's rating of the farmer feeds the FarmScore credit model.
    // Awaited (not fire-and-forget) so it completes on serverless.
    if (rater === 'buyer') {
      await recalcFarmScore(order.farmerId).catch(() => undefined)
    }

    res.json({ ok: true, order })
  }),
)

// GET /:id/pin — generate delivery PIN (farmer only)
router.get(
  '/:id/pin',
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await prisma.order.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Order not found')

    const pin = refs.deliveryPin()

    await prisma.order.update({
      where: { id: req.params.id },
      data: { deliveryPin: pin },
    })

    res.json({ pin })
  }),
)

export default router
