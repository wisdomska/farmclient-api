import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { asyncHandler, HttpError } from '../middleware/error'
import { requireAuth } from '../middleware/auth'
import { prisma } from '../config/prisma'
import { LOAN } from '../config/constants'
import { moolre } from '../services/moolre.service'
import { sendTemplate } from '../services/sms.service'

const router = Router()

// ── shared eligibility check helper ──────────────────────────────────────────

async function checkEligibility(farmerId: string) {
  const farmer = await prisma.farmer.findUnique({ where: { id: farmerId } })
  if (!farmer) throw new HttpError(404, 'Farmer not found')

  const activeLoan = await prisma.loan.findFirst({
    where: { farmerId, status: 'active' },
  })

  const completedOrders = await prisma.order.findMany({
    where: { farmerId, status: 'completed' },
    select: { subtotal: true },
  })

  const totalOrders = farmer.totalOrders
  const farmScore = farmer.farmScore
  const hasActiveLoan = activeLoan !== null

  const eligible =
    farmScore >= LOAN.minScore && totalOrders >= LOAN.minOrders && !hasActiveLoan

  let offer = 0
  if (completedOrders.length > 0) {
    const avgSubtotal =
      completedOrders.reduce((sum, o) => sum + Number(o.subtotal), 0) /
      completedOrders.length
    offer = Math.min(LOAN.maxAmount, Math.round(avgSubtotal * LOAN.offerMultiplier))
  }

  let reason: string | undefined
  if (!eligible) {
    if (hasActiveLoan) reason = 'You already have an active loan'
    else if (farmScore < LOAN.minScore)
      reason = `Farm score ${farmScore} is below the minimum of ${LOAN.minScore}`
    else if (totalOrders < LOAN.minOrders)
      reason = `You need at least ${LOAN.minOrders} completed orders (you have ${totalOrders})`
  }

  return { farmer, eligible, farmScore, totalOrders, offer, reason }
}

// GET /loans/eligibility?farmerId=
router.get(
  '/eligibility',
  asyncHandler(async (req, res) => {
    const schema = z.object({ farmerId: z.string().min(1) })
    const { farmerId } = schema.parse(req.query)
    const { eligible, farmScore, totalOrders, offer, reason } =
      await checkEligibility(farmerId)
    res.json({ eligible, farmScore, totalOrders, offer, ...(reason ? { reason } : {}) })
  }),
)

// POST /loans/request  — requireAuth
router.post(
  '/request',
  requireAuth,
  asyncHandler(async (req, res) => {
    const schema = z.object({ farmerId: z.string().min(1) })
    const { farmerId } = schema.parse(req.body)

    const { farmer, eligible, farmScore, totalOrders, offer, reason } =
      await checkEligibility(farmerId)

    if (!eligible) throw new HttpError(400, reason ?? 'Not eligible for a loan')

    const amount = new Prisma.Decimal(offer)

    const loan = await prisma.loan.create({
      data: {
        farmerId,
        amount,
        installments: LOAN.installments,
        status: 'active',
        repaidAmount: new Prisma.Decimal(0),
      },
    })

    const externalRef = 'LOAN-' + loan.id.slice(0, 8)
    const reference = `FarmClient loan disbursement to ${farmer.fullName}`

    const result = await moolre.transfer({
      network: farmer.momoNetwork,
      amount: offer,
      receiver: farmer.momoNumber,
      externalref: externalRef,
      reference,
    })

    await prisma.loan.update({
      where: { id: loan.id },
      data: { disbursementRef: result.data?.reference ?? externalRef },
    })

    await prisma.transaction.create({
      data: {
        type: 'loan',
        externalRef,
        amount,
        fee: new Prisma.Decimal(0),
        direction: 'outbound',
        status: result.ok ? 'success' : 'failed',
        moolreRef: result.data?.reference ?? null,
        latencyMs: result.latencyMs ?? null,
        requestLog: JSON.stringify({ farmerId, offer }),
        responseLog: JSON.stringify(result.raw ?? {}),
      },
    })

    await sendTemplate(farmer.phoneNumber, 'loanDisbursed', {
      amount: offer.toFixed(2),
      momo: farmer.momoNumber,
    })

    res.status(201).json({ loan, result })
  }),
)

// GET /loans/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const loan = await prisma.loan.findUnique({ where: { id: req.params.id } })
    if (!loan) throw new HttpError(404, 'Loan not found')
    res.json(loan)
  }),
)

export default router
