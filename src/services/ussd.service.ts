import { Prisma } from '@prisma/client'
import { prisma } from '../config/prisma'
import { redis } from '../config/redis'
import { getPrice } from './price.service'
import { sendTemplate } from './sms.service'
import { moolre } from './moolre.service'
import {
  LOAN,
  USSD_CROP_ORDER,
  USSD_SESSION_TTL,
  regionForDistrict,
} from '../config/constants'
import {
  hashSensitive,
  isValidGhanaCard,
  isValidGhanaMomo,
  detectNetwork,
  normalizePhone,
  refs,
  sanitizeInput,
  money,
} from '../utils/helpers'

interface Session {
  step: string
  data: Record<string, any>
}

const key = (sessionId: string) => `ussd_session:${sessionId}`

async function getSession(sessionId: string): Promise<Session | null> {
  const raw = await redis.get<Session | string>(key(sessionId))
  if (!raw) return null
  return typeof raw === 'string' ? (JSON.parse(raw) as Session) : raw
}
async function setSession(sessionId: string, s: Session) {
  await redis.set(key(sessionId), JSON.stringify(s), { ex: USSD_SESSION_TTL })
}
async function clearSession(sessionId: string) {
  await redis.del(key(sessionId))
}

const CON = (m: string) => `CON ${m}`
const END = (m: string) => `END ${m}`

function cropMenu(): string {
  // 1..10 across two lines, kept compact for the 182-char limit.
  return USSD_CROP_ORDER.map((c, i) => `${i + 1}. ${c}`).join('\n')
}

function farmerMenu(): string {
  return CON(
    'FarmClient\n1. List Harvest\n2. My Listings\n3. Market Prices\n4. My Orders\n5. My Wallet\n6. Request Loan\n0. Help',
  )
}

/**
 * Main USSD entry point. `text` is the chained input ('1*500*15072026').
 * We drive state server-side (Redis) and act on the latest segment only.
 */
export async function handleUssd(sessionId: string, phoneRaw: string, text: string): Promise<string> {
  const phone = normalizePhone(phoneRaw)
  const latest = text === '' ? '' : sanitizeInput(text.split('*').pop() ?? '')

  // Fresh dial → reset to root.
  if (text === '') {
    const farmer = await prisma.farmer.findUnique({ where: { phoneNumber: phone } })
    await setSession(sessionId, { step: 'root', data: { registered: !!farmer } })
    return CON('Welcome to FarmClient\n1. Register\n2. Login\n3. Check Market Prices')
  }

  let session = await getSession(sessionId)
  if (!session) {
    session = { step: 'root', data: {} }
  }

  try {
    return await route(sessionId, phone, latest, session)
  } catch (err) {
    await clearSession(sessionId)
    return END('Sorry, something went wrong. Please dial *789# to try again.')
  }
}

async function route(sessionId: string, phone: string, input: string, s: Session): Promise<string> {
  switch (s.step) {
    case 'root':
      return rootMenu(sessionId, phone, input)

    // ── Registration ──
    case 'reg_card':
      if (!isValidGhanaCard(input)) return CON('Invalid Ghana Card. Format GHA-XXXXXXXXX-X.\nEnter your Ghana Card number:')
      s.data.card = input.toUpperCase()
      s.step = 'reg_name'
      await setSession(sessionId, s)
      return CON('Enter your full name:')
    case 'reg_name':
      s.data.name = input
      s.step = 'reg_district'
      await setSession(sessionId, s)
      return CON('Enter your district (e.g. Techiman, Kumasi, Tamale):')
    case 'reg_district':
      s.data.district = input
      s.step = 'reg_crop'
      await setSession(sessionId, s)
      return CON('Select your main crop:\n' + cropMenu())
    case 'reg_crop': {
      const idx = parseInt(input, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= USSD_CROP_ORDER.length) return CON('Invalid choice.\nSelect your main crop:\n' + cropMenu())
      s.data.crop = USSD_CROP_ORDER[idx]
      s.step = 'reg_momo'
      await setSession(sessionId, s)
      return CON('Enter your mobile money number (for payouts):')
    }
    case 'reg_momo':
      return finishRegistration(sessionId, phone, input, s)

    // ── Login → farmer menu ──
    case 'menu':
      return farmerMenuRouter(sessionId, phone, input, s)

    // ── List harvest ──
    case 'lh_crop':
      return listHarvestCrop(sessionId, input, s)
    case 'lh_qty':
      if (!/^\d+(\.\d+)?$/.test(input)) return CON('Enter quantity in kg (e.g. 500):')
      s.data.qty = parseFloat(input)
      s.step = 'lh_date'
      await setSession(sessionId, s)
      return CON('Enter expected harvest date (DDMMYYYY):')
    case 'lh_date':
      s.data.date = input
      s.step = 'lh_price'
      await setSession(sessionId, s)
      return CON('Enter asking price per kg in GHS (or 0 for AI suggestion):')
    case 'lh_price':
      return listHarvestPrice(sessionId, phone, input, s)
    case 'lh_ai_confirm':
      return listHarvestAiConfirm(sessionId, phone, input, s)

    // ── Market prices ──
    case 'prices_crop':
      return showPrice(sessionId, phone, input, s)

    // ── My orders ──
    case 'orders_select':
      return orderSelect(sessionId, phone, input, s)

    // ── Loan ──
    case 'loan_offer':
      return loanAccept(sessionId, phone, input, s)

    default:
      await clearSession(sessionId)
      return END('Session expired. Dial *789# to start again.')
  }
}

async function rootMenu(sessionId: string, phone: string, input: string): Promise<string> {
  if (input === '1') {
    const existing = await prisma.farmer.findUnique({ where: { phoneNumber: phone } })
    if (existing) {
      await clearSession(sessionId)
      return END(`This number is already registered (${existing.farmvaultId}). Dial *789# and choose Login.`)
    }
    await setSession(sessionId, { step: 'reg_card', data: {} })
    return CON('Enter your 10-digit Ghana Card number (GHA-XXXXXXXXX-X):')
  }
  if (input === '2') {
    const farmer = await prisma.farmer.findUnique({ where: { phoneNumber: phone } })
    if (!farmer) {
      await clearSession(sessionId)
      return END('No account found for this number. Dial *789# and choose Register.')
    }
    await setSession(sessionId, { step: 'menu', data: { farmerId: farmer.id } })
    return farmerMenu()
  }
  if (input === '3') {
    await setSession(sessionId, { step: 'prices_crop', data: {} })
    return CON('Select crop:\n' + cropMenu())
  }
  return CON('Invalid choice.\n1. Register\n2. Login\n3. Check Market Prices')
}

async function finishRegistration(sessionId: string, phone: string, momoInput: string, s: Session): Promise<string> {
  const momo = normalizePhone(momoInput)
  if (!isValidGhanaMomo(momo)) return CON('Invalid MoMo number. Enter a valid Ghanaian number:')
  const network = detectNetwork(momo)
  if (!network) return CON('Could not detect network. Enter a valid MoMo number:')

  const district = s.data.district as string
  const farmvaultId = refs.farmvaultId()
  const farmer = await prisma.farmer.create({
    data: {
      farmvaultId,
      fullName: s.data.name,
      phoneNumber: phone,
      ghanaCardHash: hashSensitive(s.data.card),
      ghanaCardLast: (s.data.card as string).slice(-4),
      district,
      region: regionForDistrict(district),
      momoNumber: momo,
      momoNetwork: network,
      crops: [s.data.crop],
      regChannel: 'ussd',
      verification: 'pending',
    },
  })
  await clearSession(sessionId)
  sendTemplate(farmer.phoneNumber, 'registration', { name: farmer.fullName, farmvaultId }).catch(() => undefined)
  return END(`Registration complete! Your FarmClient ID is ${farmvaultId}.\nDial *789# anytime to list your harvest or check prices.`)
}

async function farmerMenuRouter(sessionId: string, phone: string, input: string, s: Session): Promise<string> {
  const farmer = await prisma.farmer.findUnique({ where: { id: s.data.farmerId } })
  if (!farmer) {
    await clearSession(sessionId)
    return END('Account error. Dial *789# to login again.')
  }
  switch (input) {
    case '1': {
      s.step = 'lh_crop'
      await setSession(sessionId, s)
      const crops = farmer.crops.length ? farmer.crops : [...USSD_CROP_ORDER]
      s.data.cropChoices = crops
      await setSession(sessionId, s)
      return CON('Select crop:\n' + crops.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n'))
    }
    case '2': {
      const listings = await prisma.listing.findMany({
        where: { farmerId: farmer.id, status: { in: ['active', 'partial', 'reserved'] } },
        take: 4,
        orderBy: { createdAt: 'desc' },
      })
      await clearSession(sessionId)
      if (!listings.length) return END('You have no active listings. Dial *789# to list a harvest.')
      const lines = listings.map((l) => `${l.listingRef} ${l.cropType} ${l.qtyRemaining}kg ${l.status}`).join('\n')
      return END('Your listings:\n' + lines)
    }
    case '3':
      s.step = 'prices_crop'
      await setSession(sessionId, s)
      return CON('Select crop:\n' + cropMenu())
    case '4': {
      const orders = await prisma.order.findMany({
        where: { farmerId: farmer.id, status: { in: ['confirmed', 'in_progress', 'delivered'] } },
        take: 5,
        orderBy: { createdAt: 'desc' },
      })
      if (!orders.length) {
        await clearSession(sessionId)
        return END('You have no pending orders.')
      }
      s.step = 'orders_select'
      s.data.orderIds = orders.map((o) => o.id)
      await setSession(sessionId, s)
      const lines = orders.map((o, i) => `${i + 1}. ${o.orderRef} ${o.cropType} ${o.quantityKg}kg ${o.status}`).join('\n')
      return CON('Your orders:\n' + lines + '\nSelect an order:')
    }
    case '5': {
      const pending = await prisma.order.aggregate({
        where: { farmerId: farmer.id, status: { in: ['confirmed', 'in_progress', 'delivered'] } },
        _sum: { subtotal: true },
      })
      await clearSession(sessionId)
      return END(
        `Wallet\nPaid out: GHS ${money(Number(farmer.totalRevenue))}\nPending: GHS ${money(Number(pending._sum.subtotal ?? 0))}\nFarmScore: ${farmer.farmScore}`,
      )
    }
    case '6':
      return loanCheck(sessionId, farmer.id, s)
    case '0':
    case '7':
      await clearSession(sessionId)
      sendTemplate(farmer.phoneNumber, 'registration', { name: farmer.fullName, farmvaultId: farmer.farmvaultId }).catch(() => undefined)
      return END('Help is on the way. We have sent you an SMS. Call 0800-FARM for support.')
    default:
      return farmerMenu()
  }
}

async function listHarvestCrop(sessionId: string, input: string, s: Session): Promise<string> {
  const crops: string[] = s.data.cropChoices ?? [...USSD_CROP_ORDER]
  const idx = parseInt(input, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= crops.length) return CON('Invalid choice.\nSelect crop:\n' + crops.map((c, i) => `${i + 1}. ${c}`).join('\n'))
  s.data.crop = crops[idx]
  s.step = 'lh_qty'
  await setSession(sessionId, s)
  return CON('Enter quantity in kg (e.g. 500):')
}

function parseUssdDate(d: string): Date | null {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(d)
  if (!m) return null
  const dt = new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`)
  return isNaN(dt.getTime()) ? null : dt
}

async function listHarvestPrice(sessionId: string, phone: string, input: string, s: Session): Promise<string> {
  if (input === '0') {
    const farmer = await prisma.farmer.findUnique({ where: { id: s.data.farmerId } })
    const region = farmer?.region ?? 'Greater Accra'
    const price = await getPrice(s.data.crop, region)
    s.data.aiPrice = price.price
    s.step = 'lh_ai_confirm'
    await setSession(sessionId, s)
    return CON(`AI Price: Fair price for ${s.data.crop} today is GHS ${money(price.price)}/kg.\n1. Use this price\n2. Enter my own`)
  }
  if (!/^\d+(\.\d+)?$/.test(input)) return CON('Enter asking price per kg in GHS (or 0 for AI suggestion):')
  return createListing(sessionId, phone, parseFloat(input), null, s)
}

async function listHarvestAiConfirm(sessionId: string, phone: string, input: string, s: Session): Promise<string> {
  if (input === '1') return createListing(sessionId, phone, s.data.aiPrice, s.data.aiPrice, s)
  if (input === '2') {
    s.step = 'lh_price'
    await setSession(sessionId, s)
    return CON('Enter your asking price per kg in GHS:')
  }
  return CON(`1. Use GHS ${money(s.data.aiPrice)}/kg\n2. Enter my own`)
}

async function createListing(sessionId: string, _phone: string, price: number, aiPrice: number | null, s: Session): Promise<string> {
  const farmer = await prisma.farmer.findUnique({ where: { id: s.data.farmerId } })
  if (!farmer) {
    await clearSession(sessionId)
    return END('Account error. Dial *789# again.')
  }
  const harvest = parseUssdDate(s.data.date) ?? new Date()
  const listingRef = refs.listing()
  await prisma.listing.create({
    data: {
      listingRef,
      farmerId: farmer.id,
      cropType: s.data.crop,
      quantityKg: new Prisma.Decimal(s.data.qty),
      qtyRemaining: new Prisma.Decimal(s.data.qty),
      pricePerKg: new Prisma.Decimal(price),
      aiPrice: aiPrice != null ? new Prisma.Decimal(aiPrice) : null,
      harvestDate: harvest,
      district: farmer.district,
      region: farmer.region,
      status: 'active',
      channel: 'ussd',
      expiresAt: new Date(harvest.getTime() + 14 * 24 * 60 * 60 * 1000),
    },
  })
  await clearSession(sessionId)
  return END(`Harvest listed! Listing ID: ${listingRef}.\nYou will receive an SMS when a buyer is interested.`)
}

async function showPrice(sessionId: string, phone: string, input: string, s: Session): Promise<string> {
  const idx = parseInt(input, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= USSD_CROP_ORDER.length) return CON('Invalid choice.\nSelect crop:\n' + cropMenu())
  const crop = USSD_CROP_ORDER[idx]
  const farmer = await prisma.farmer.findUnique({ where: { phoneNumber: phone } })
  const region = farmer?.region ?? 'Greater Accra'
  const p = await getPrice(crop, region)
  await clearSession(sessionId)
  const dir = p.trend === 'up' ? 'UP' : p.trend === 'down' ? 'DOWN' : 'STABLE'
  return END(
    `${crop} in ${region}:\nFair price: GHS ${money(p.price)}/kg\nTrend: ${dir} ${Math.abs(p.changePct)}% this week.`,
  )
}

async function orderSelect(sessionId: string, phone: string, input: string, s: Session): Promise<string> {
  const ids: string[] = s.data.orderIds ?? []
  const idx = parseInt(input, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= ids.length) return CON('Invalid choice. Select an order:')
  const order = await prisma.order.findUnique({ where: { id: ids[idx] } })
  if (!order) {
    await clearSession(sessionId)
    return END('Order not found.')
  }
  // Confirm acceptance + provide a delivery PIN.
  const pin = order.deliveryPin ?? refs.deliveryPin()
  await prisma.order.update({
    where: { id: order.id },
    data: { status: order.status === 'confirmed' ? 'in_progress' : order.status, deliveryPin: pin },
  })
  await clearSession(sessionId)
  return END(`Order ${order.orderRef} confirmed.\nDelivery PIN: ${pin}\nGive this PIN to the buyer on delivery.`)
}

async function loanCheck(sessionId: string, farmerId: string, s: Session): Promise<string> {
  const farmer = await prisma.farmer.findUnique({ where: { id: farmerId } })
  if (!farmer) {
    await clearSession(sessionId)
    return END('Account error.')
  }
  const existingActive = await prisma.loan.findFirst({ where: { farmerId, status: 'active' } })
  if (existingActive) {
    await clearSession(sessionId)
    return END(`You have an active advance of GHS ${money(Number(existingActive.amount))}. Repaid: GHS ${money(Number(existingActive.repaidAmount))}.`)
  }
  if (farmer.farmScore < LOAN.minScore || farmer.totalOrders < LOAN.minOrders) {
    await clearSession(sessionId)
    return END(
      `Not eligible yet.\nFarmScore: ${farmer.farmScore} (need ${LOAN.minScore})\nCompleted orders: ${farmer.totalOrders} (need ${LOAN.minOrders}).`,
    )
  }
  // Offer = avg order value × 0.8, capped.
  const agg = await prisma.order.aggregate({ where: { farmerId, status: 'completed' }, _avg: { subtotal: true } })
  const avg = Number(agg._avg.subtotal ?? 0)
  const offer = Math.min(LOAN.maxAmount, Math.round(avg * LOAN.offerMultiplier))
  s.step = 'loan_offer'
  s.data.farmerId = farmerId
  s.data.offer = offer
  await setSession(sessionId, s)
  return CON(
    `Harvest Advance offer: GHS ${money(offer)}\nRepaid from your next ${LOAN.installments} payouts.\n1. Accept\n2. Cancel`,
  )
}

async function loanAccept(sessionId: string, _phone: string, input: string, s: Session): Promise<string> {
  if (input !== '1') {
    await clearSession(sessionId)
    return END('Loan request cancelled.')
  }
  const farmer = await prisma.farmer.findUnique({ where: { id: s.data.farmerId } })
  if (!farmer) {
    await clearSession(sessionId)
    return END('Account error.')
  }
  const amount = Number(s.data.offer)
  const loan = await prisma.loan.create({
    data: { farmerId: farmer.id, amount: new Prisma.Decimal(amount), installments: LOAN.installments, status: 'active' },
  })
  // Disburse via Moolre.
  const ref = `LOAN-${loan.id.slice(0, 8)}`
  const res = await moolre.transfer({
    network: farmer.momoNetwork,
    amount,
    receiver: farmer.momoNumber,
    externalref: ref,
    reference: `FarmClient harvest advance for ${farmer.farmvaultId}`,
  })
  await prisma.loan.update({ where: { id: loan.id }, data: { disbursementRef: ref } })
  await prisma.transaction.create({
    data: {
      type: 'loan',
      externalRef: ref,
      amount: new Prisma.Decimal(amount),
      direction: 'outbound',
      status: res.ok ? 'pending' : 'failed',
      moolreRef: res.code,
      actorId: farmer.id,
      actorType: 'farmer',
    },
  })
  await clearSession(sessionId)
  sendTemplate(farmer.phoneNumber, 'loanDisbursed', { amount: money(amount), momo: farmer.momoNumber }).catch(() => undefined)
  return END(`Approved! GHS ${money(amount)} is being sent to your ${farmer.momoNetwork} MoMo. Repaid from your next ${LOAN.installments} payouts.`)
}
