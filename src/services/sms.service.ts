import { prisma } from '../config/prisma'
import { moolre } from './moolre.service'
import { normalizePhone } from '../utils/helpers'

/**
 * SMS templates (SRS §FR-11.1). Each builder returns a <=160 char message.
 */
export const smsTemplates = {
  registration: (v: { name: string; farmvaultId: string }) =>
    `Welcome to FarmClient, ${v.name}! Your ID is ${v.farmvaultId}. Dial *789# to list your harvest.`,

  newOrder: (v: { qty: string; crop: string; buyerName: string; orderRef: string; date: string }) =>
    `FarmClient: New order for ${v.qty}kg of ${v.crop} from buyer ${v.buyerName}. Order: ${v.orderRef}. Delivery by ${v.date}. Dial *789# to confirm.`,

  orderConfirmed: (v: { farmerName: string; orderRef: string; qty: string; crop: string; date: string }) =>
    `FarmClient: ${v.farmerName} confirmed your order ${v.orderRef} for ${v.qty}kg of ${v.crop}. Expected delivery: ${v.date}.`,

  deliveryConfirmed: (v: { orderRef: string; amount: string; network: string; momo: string }) =>
    `FarmClient: Delivery confirmed for Order ${v.orderRef}. GHS ${v.amount} is being sent to your ${v.network} MoMo (${v.momo}).`,

  payoutSuccess: (v: { amount: string; momo: string; orderRef: string }) =>
    `FarmClient: GHS ${v.amount} sent to ${v.momo} for Order ${v.orderRef}. Thank you for using FarmClient!`,

  priceAlert: (v: { crop: string; region: string; price: string; dir: string; pct: string }) =>
    `FarmClient Price Alert: ${v.crop} in ${v.region} is GHS ${v.price}/kg today. Trend: ${v.dir} ${v.pct}%. Dial *789# to list your harvest.`,

  loanDisbursed: (v: { amount: string; momo: string }) =>
    `FarmClient: Your harvest advance of GHS ${v.amount} has been sent to ${v.momo}. Repaid automatically from your next 3 payouts.`,

  listingExpiring: (v: { crop: string; listingRef: string }) =>
    `FarmClient: Your ${v.crop} listing (${v.listingRef}) expires in 3 days. Dial *789# to renew or update.`,

  disputeRaised: (v: { orderRef: string }) =>
    `FarmClient: A dispute has been raised on Order ${v.orderRef}. Our team will contact you within 24 hours.`,
}

/** Twi (Akan) variants of the SMS templates (SRS NFR: Twi localisation). */
export const smsTemplatesTw = {
  registration: (v: { name: string; farmvaultId: string }) =>
    `Akwaaba ${v.name}! Wo FarmClient ID ne ${v.farmvaultId}. Frɛ *789# fa to wo nnɔbae.`,

  newOrder: (v: { qty: string; crop: string; buyerName: string; orderRef: string; date: string }) =>
    `FarmClient: Tɔdeɛ foforɔ ${v.qty}kg ${v.crop} firi ${v.buyerName}. Order: ${v.orderRef}. Fa ma ${v.date}. Frɛ *789# si so dua.`,

  orderConfirmed: (v: { farmerName: string; orderRef: string; qty: string; crop: string; date: string }) =>
    `FarmClient: ${v.farmerName} agye wo order ${v.orderRef} ma ${v.qty}kg ${v.crop}. Wɔbɛ de aba ${v.date}.`,

  deliveryConfirmed: (v: { orderRef: string; amount: string; network: string; momo: string }) =>
    `FarmClient: Order ${v.orderRef} aba. Yɛde GHS ${v.amount} rekɔ wo ${v.network} MoMo (${v.momo}).`,

  payoutSuccess: (v: { amount: string; momo: string; orderRef: string }) =>
    `FarmClient: GHS ${v.amount} akɔ ${v.momo} ma Order ${v.orderRef}. Yɛda wo ase!`,

  priceAlert: (v: { crop: string; region: string; price: string; dir: string; pct: string }) =>
    `FarmClient: ${v.crop} wɔ ${v.region} yɛ GHS ${v.price}/kg ɛnnɛ. ${v.dir} ${v.pct}%. Frɛ *789# fa to wo nnɔbae.`,

  loanDisbursed: (v: { amount: string; momo: string }) =>
    `FarmClient: Wo bosea GHS ${v.amount} akɔ ${v.momo}. Yɛbɛtwe afiri wo tɔ a edi so mmiɛnsa mu.`,

  listingExpiring: (v: { crop: string; listingRef: string }) =>
    `FarmClient: Wo ${v.crop} (${v.listingRef}) bɛba awieeɛ nnansa. Frɛ *789# fa foforɔ to.`,

  disputeRaised: (v: { orderRef: string }) =>
    `FarmClient: Asɛm aba Order ${v.orderRef} ho. Yɛbɛfrɛ wo wɔ nnɔnhwerew 24 mu.`,
}

export type SmsTemplateKey = keyof typeof smsTemplates
export type Lang = 'en' | 'tw'

/**
 * Send an SMS via Moolre and persist it to sms_log. Never throws — SMS is
 * best-effort and must not break the financial flow.
 */
export async function sendSms(
  recipient: string,
  message: string,
  templateKey?: string,
): Promise<void> {
  const to = normalizePhone(recipient)
  const text = message.slice(0, 160)
  let status: 'sent' | 'failed' = 'failed'
  let moolreRef: string | undefined

  try {
    const res = await moolre.sendSms(to, text)
    status = res.ok ? 'sent' : 'failed'
    moolreRef = res.raw?.data?.ref ?? res.code
  } catch {
    status = 'failed'
  }

  try {
    await prisma.smsLog.create({
      data: { recipient: to, message: text, templateKey, moolreRef, status },
    })
  } catch {
    /* logging must not throw */
  }
}

/** Typed helper: render a template (in the given language) and send it. */
export async function sendTemplate<K extends SmsTemplateKey>(
  recipient: string,
  key: K,
  vars: Parameters<(typeof smsTemplates)[K]>[0],
  lang: Lang = 'en',
): Promise<void> {
  const table = lang === 'tw' ? smsTemplatesTw : smsTemplates
  // @ts-expect-error — vars matches the template builder's parameter by construction
  const message = table[key](vars)
  await sendSms(recipient, message, key)
}
