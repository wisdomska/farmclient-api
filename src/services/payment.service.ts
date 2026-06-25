import { Prisma } from '@prisma/client'
import { prisma } from '../config/prisma'
import { moolre, MoolreResult } from './moolre.service'
import { sendTemplate } from './sms.service'
import { recalcFarmScore } from './score.service'
import { money } from '../utils/helpers'
import { LOAN } from '../config/constants'

/** Persist a Moolre call as an immutable transaction row. */
async function logTx(args: {
  orderId?: string
  type: 'collection' | 'disbursement' | 'loan' | 'loan_repayment'
  externalRef: string
  amount: number
  fee?: number
  direction: 'inbound' | 'outbound'
  status: 'pending' | 'success' | 'failed'
  res?: MoolreResult
  actorId?: string
  actorType?: string
  meta?: Record<string, unknown>
}) {
  return prisma.transaction.upsert({
    where: { externalRef: args.externalRef },
    update: {
      status: args.status,
      moolreTxId: args.res?.raw?.data?.transactionid ?? args.res?.raw?.data?.txid,
      moolreRef: args.res?.code,
      responseLog: (args.res?.raw ?? args.meta ?? {}) as Prisma.InputJsonValue,
      latencyMs: args.res?.latencyMs,
    },
    create: {
      orderId: args.orderId,
      type: args.type,
      externalRef: args.externalRef,
      amount: new Prisma.Decimal(args.amount),
      fee: new Prisma.Decimal(args.fee ?? 0),
      direction: args.direction,
      status: args.status,
      moolreRef: args.res?.code,
      moolreTxId: args.res?.raw?.data?.transactionid,
      actorId: args.actorId,
      actorType: args.actorType,
      requestLog: (args.meta ?? {}) as Prisma.InputJsonValue,
      responseLog: (args.res?.raw ?? {}) as Prisma.InputJsonValue,
      latencyMs: args.res?.latencyMs,
    },
  })
}

async function audit(entity: string, entityId: string, action: string, prev?: string, next?: string, meta?: object) {
  try {
    await prisma.auditLog.create({
      data: { entity, entityId, action, prevState: prev, newState: next, meta: (meta ?? {}) as Prisma.InputJsonValue },
    })
  } catch {
    /* never throw */
  }
}

/** Farmer payout = subtotal − platform fee (SRS §FR-08.1). */
export function computeGrossPayout(subtotal: number, platformFee: number): number {
  return Math.max(0, subtotal - platformFee)
}

/**
 * Initiate buyer escrow collection (Moolre Collections). Idempotent on order_ref.
 */
export async function initiateEscrow(orderId: string): Promise<MoolreResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { buyer: true, farmer: true } })
  if (!order) throw new Error('Order not found')

  // Idempotency: never double-charge.
  const existing = await prisma.transaction.findUnique({ where: { externalRef: order.orderRef } })
  if (existing && existing.status === 'success') {
    return { ok: true, code: 'TR099', message: 'Already collected', latencyMs: 0 }
  }

  const network = order.buyer.phoneNumber ? detectBuyerNetwork(order.buyer.phoneNumber) : 'MTN'
  const res = await moolre.initiateCollection({
    network,
    payer: order.buyer.phoneNumber ?? '',
    amount: Number(order.totalPaid),
    externalref: order.orderRef,
    reference: `FarmClient Order ${order.orderRef} - ${order.cropType} ${order.quantityKg}kg`,
  })

  await logTx({
    orderId: order.id,
    type: 'collection',
    externalRef: order.orderRef,
    amount: Number(order.totalPaid),
    fee: Number(order.platformFee),
    direction: 'inbound',
    status: res.ok ? 'pending' : 'failed',
    res,
    actorId: order.buyerId,
    actorType: 'buyer',
  })
  return res
}

/**
 * Resubmit an order's collection — used to complete Moolre's OTP verification
 * (TP14). Reuses the same externalref (order_ref) and adds the otpcode.
 */
export async function retryCollection(orderId: string, otpcode?: string): Promise<MoolreResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { buyer: true } })
  if (!order) throw new Error('Order not found')
  if (order.status !== 'pending_payment') {
    return { ok: true, code: 'TR099', message: 'Already confirmed', latencyMs: 0 }
  }
  const network = order.buyer.phoneNumber ? detectBuyerNetwork(order.buyer.phoneNumber) : 'MTN'
  const res = await moolre.initiateCollection({
    network,
    payer: order.buyer.phoneNumber ?? '',
    amount: Number(order.totalPaid),
    externalref: order.orderRef,
    reference: `FarmClient Order ${order.orderRef} - ${order.cropType} ${order.quantityKg}kg`,
    otpcode,
  })
  await logTx({
    orderId: order.id,
    type: 'collection',
    externalRef: order.orderRef,
    amount: Number(order.totalPaid),
    fee: Number(order.platformFee),
    direction: 'inbound',
    status: res.ok ? 'pending' : 'failed',
    res,
    actorId: order.buyerId,
    actorType: 'buyer',
  })
  return res
}

function detectBuyerNetwork(phone: string) {
  // Buyers may pay from any network; default MTN if undetectable.
  // (helpers.detectNetwork imported lazily to avoid cycle is unnecessary; inline simple map)
  const p = phone.replace(/\D/g, '')
  const local = p.startsWith('233') ? '0' + p.slice(3) : p
  const pre = local.slice(0, 3)
  if (['020', '050'].includes(pre)) return 'TELECEL' as const
  if (['026', '027', '056', '057'].includes(pre)) return 'AIRTELTIGO' as const
  return 'MTN' as const
}

/** Generate a Moolre payment link (card/bank alternative). */
export async function createPaymentLinkFor(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { buyer: true } })
  if (!order) throw new Error('Order not found')
  const res = await moolre.createPaymentLink({
    amount: Number(order.totalPaid),
    email: order.buyer.email ?? 'buyer@farmclient.app',
    externalref: order.orderRef,
    orderRef: order.orderRef,
  })
  await logTx({
    orderId: order.id,
    type: 'collection',
    externalRef: order.orderRef,
    amount: Number(order.totalPaid),
    fee: Number(order.platformFee),
    direction: 'inbound',
    status: res.ok ? 'pending' : 'failed',
    res,
  })
  return res
}

/**
 * Collection webhook success — fund escrow, confirm order, notify both sides.
 * Idempotent: re-delivery of the same webhook is a no-op after first success.
 */
export async function onCollectionSuccess(externalref: string, moolreTxId?: string, _amount?: string) {
  const order = await prisma.order.findUnique({
    where: { orderRef: externalref },
    include: { farmer: true, buyer: true },
  })
  if (!order) return { handled: false, reason: 'unknown order' }
  if (order.status !== 'pending_payment') return { handled: true, idempotent: true }

  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'confirmed', escrowRef: externalref },
  })
  await logTx({
    orderId: order.id,
    type: 'collection',
    externalRef: externalref,
    amount: Number(order.totalPaid),
    fee: Number(order.platformFee),
    direction: 'inbound',
    status: 'success',
    meta: { moolreTxId },
  })
  await audit('order', order.orderRef, 'collection_success', 'pending_payment', 'confirmed')

  const date = order.deliveryDate ? order.deliveryDate.toISOString().slice(0, 10) : 'soon'
  await sendTemplate(
    order.farmer.phoneNumber,
    'newOrder',
    {
      qty: String(order.quantityKg),
      crop: order.cropType,
      buyerName: order.buyer.fullName,
      orderRef: order.orderRef,
      date,
    },
    order.farmer.language as 'en' | 'tw',
  )
  if (order.buyer.phoneNumber) {
    await sendTemplate(order.buyer.phoneNumber, 'orderConfirmed', {
      farmerName: order.farmer.fullName,
      orderRef: order.orderRef,
      qty: String(order.quantityKg),
      crop: order.cropType,
      date,
    })
  }
  return { handled: true }
}

/**
 * Trigger farmer payout: validate recipient → compute net (minus any loan
 * installment) → disburse. Idempotent on PAYOUT-{orderRef}.
 */
export async function triggerPayout(orderId: string): Promise<MoolreResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { farmer: true } })
  if (!order) throw new Error('Order not found')

  const payoutRef = `PAYOUT-${order.orderRef}`
  const existing = await prisma.transaction.findUnique({ where: { externalRef: payoutRef } })
  if (existing && existing.status === 'success') {
    return { ok: true, code: 'OBGH01', message: 'Already paid out', latencyMs: 0 }
  }

  // Validate recipient first (SRS FR-08.1 step 1).
  const validation = await moolre.validateRecipient({
    receiver: order.farmer.momoNumber,
    network: order.farmer.momoNetwork,
  })
  if (!validation.ok) {
    await audit('payout', order.orderRef, 'validate_failed', undefined, undefined, { message: validation.message })
    return validation
  }

  const gross = computeGrossPayout(Number(order.subtotal), Number(order.platformFee))

  // Auto-deduct an active loan installment from this payout.
  const loan = await prisma.loan.findFirst({
    where: { farmerId: order.farmerId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  })
  let loanDue = 0
  if (loan) {
    const installment = Number(loan.amount) / loan.installments
    const remaining = Number(loan.amount) - Number(loan.repaidAmount)
    loanDue = Math.min(installment, remaining)
  }
  const net = Math.max(0, gross - loanDue)

  const res = await moolre.transfer({
    network: order.farmer.momoNetwork,
    amount: net,
    receiver: order.farmer.momoNumber,
    externalref: payoutRef,
    reference: `FarmClient payout: ${order.cropType} ${order.quantityKg}kg order ${order.orderRef}`,
  })

  await logTx({
    orderId: order.id,
    type: 'disbursement',
    externalRef: payoutRef,
    amount: net,
    direction: 'outbound',
    status: res.ok ? 'pending' : 'failed',
    res,
    actorId: order.farmerId,
    actorType: 'farmer',
    meta: { gross, loanDue, loanId: loan?.id ?? null, net },
  })
  return res
}

/**
 * Disbursement webhook success — complete order, credit farmer stats, apply
 * loan repayment, recalc score, notify farmer. Idempotent.
 */
export async function onDisbursementSuccess(externalref: string, moolreTxId?: string) {
  const orderRef = externalref.replace(/^PAYOUT-/, '')
  const order = await prisma.order.findUnique({ where: { orderRef }, include: { farmer: true } })
  if (!order) return { handled: false, reason: 'unknown order' }
  if (order.status === 'completed') return { handled: true, idempotent: true }

  const payoutTx = await prisma.transaction.findUnique({ where: { externalRef: externalref } })
  const meta = (payoutTx?.requestLog as any) ?? {}
  const net = Number(meta.net ?? order.subtotal)
  const loanDue = Number(meta.loanDue ?? 0)
  const loanId = meta.loanId as string | null

  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'completed', payoutRef: externalref, completedAt: new Date() },
  })
  await logTx({
    orderId: order.id,
    type: 'disbursement',
    externalRef: externalref,
    amount: net,
    direction: 'outbound',
    status: 'success',
    meta: { moolreTxId },
  })

  // Credit farmer stats.
  await prisma.farmer.update({
    where: { id: order.farmerId },
    data: {
      totalRevenue: { increment: new Prisma.Decimal(net) },
      totalOrders: { increment: 1 },
    },
  })

  // Apply loan repayment.
  if (loanId && loanDue > 0) {
    const loan = await prisma.loan.findUnique({ where: { id: loanId } })
    if (loan && loan.status === 'active') {
      const repaid = Number(loan.repaidAmount) + loanDue
      const done = repaid >= Number(loan.amount) - 0.001
      await prisma.loan.update({
        where: { id: loan.id },
        data: { repaidAmount: new Prisma.Decimal(repaid), status: done ? 'repaid' : 'active' },
      })
      await logTx({
        orderId: order.id,
        type: 'loan_repayment',
        externalRef: `REPAY-${order.orderRef}`,
        amount: loanDue,
        direction: 'inbound',
        status: 'success',
        meta: { loanId },
      })
    }
  }

  await audit('order', order.orderRef, 'payout_success', order.status, 'completed', { net, loanDue })

  // Recalculate score (awaited so it completes on serverless).
  await recalcFarmScore(order.farmerId).catch(() => undefined)

  await sendTemplate(
    order.farmer.phoneNumber,
    'payoutSuccess',
    { amount: money(net), momo: order.farmer.momoNumber, orderRef: order.orderRef },
    order.farmer.language as 'en' | 'tw',
  )
  return { handled: true }
}

export { LOAN }
