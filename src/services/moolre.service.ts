import axios, { AxiosError, AxiosRequestConfig } from 'axios'
import { env, moolreBaseUrl } from '../config/env'
import { MomoNetwork } from '@prisma/client'
import { CHANNEL } from '../config/constants'
import { money, withRetry } from '../utils/helpers'

/**
 * Moolre API client — the exclusive payment/SMS/USSD financial layer.
 *
 * Header strategy (SRS §FR-06/08/11):
 *   - Disbursements / validate / balance / collection initiate → X-API-USER + X-API-KEY (private)
 *   - Collections via payment link / status → X-API-USER + X-API-PUBKEY (public)
 *   - SMS → X-API-VASKEY
 * In sandbox mode only X-API-USER is required.
 */

type KeyKind = 'private' | 'public' | 'vas'

export interface MoolreResult<T = any> {
  ok: boolean
  code?: string
  status?: number
  message?: string
  data?: T
  raw?: any
  latencyMs: number
}

function headers(kind: KeyKind): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-USER': env.moolre.apiUser,
  }
  if (env.moolre.useSandbox) return h // sandbox: only X-API-USER
  if (kind === 'private') h['X-API-KEY'] = env.moolre.apiKey
  if (kind === 'public') h['X-API-PUBKEY'] = env.moolre.pubKey
  if (kind === 'vas') h['X-API-VASKEY'] = env.moolre.vasKey
  return h
}

async function call<T = any>(
  method: 'GET' | 'POST',
  path: string,
  kind: KeyKind,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
): Promise<MoolreResult<T>> {
  const url = `${moolreBaseUrl()}${path}`
  const cfg: AxiosRequestConfig = {
    method,
    url,
    headers: headers(kind),
    timeout: 20000,
    ...(body ? { data: body } : {}),
    ...(params ? { params } : {}),
  }
  const started = Date.now()
  try {
    const res = await withRetry(() => axios.request(cfg), 3, 1000)
    const latencyMs = Date.now() - started
    const r = res.data ?? {}
    // Moolre returns { status: 1, code, message, data }
    const ok = r.status === 1 || r.status === '1'
    return { ok, code: r.code, status: r.status, message: r.message, data: r.data, raw: r, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    const ax = err as AxiosError<any>
    return {
      ok: false,
      status: ax.response?.status,
      message: (ax.response?.data as any)?.message ?? ax.message,
      raw: ax.response?.data ?? { error: ax.message },
      latencyMs,
    }
  }
}

export const moolre = {
  /** Build the request payload for a collection without sending (used by callers for logging). */
  collectionChannel(network: MomoNetwork): number {
    return CHANNEL.collection[network]
  },
  transferChannel(network: MomoNetwork): number {
    return CHANNEL.transfer[network]
  },

  /** 1. COLLECTION — initiate buyer payment (escrow). Pushes a MoMo approval to payer. */
  async initiateCollection(args: {
    network: MomoNetwork
    payer: string
    amount: number
    externalref: string
    reference: string
  }): Promise<MoolreResult> {
    return call('POST', '/open/transact/payment', 'private', {
      type: 1,
      channel: CHANNEL.collection[args.network],
      currency: 'GHS',
      payer: args.payer,
      amount: money(args.amount),
      externalref: args.externalref,
      reference: args.reference,
      accountnumber: env.moolre.accountNumber,
    })
  },

  /** 2. PAYMENT LINK — alternative card/bank collection. Returns authorization_url. */
  async createPaymentLink(args: {
    amount: number
    email: string
    externalref: string
    orderRef: string
  }): Promise<MoolreResult<{ authorization_url: string; reference: string }>> {
    return call('POST', '/embed/link', 'public', {
      type: 1,
      amount: money(args.amount),
      email: args.email,
      externalref: args.externalref,
      callback: `${env.apiUrl}/webhook/moolre/collection`,
      redirect: `${env.frontendUrl}/orders/${args.orderRef}/success`,
      reusable: '0',
      expiration_time: 30,
      currency: 'GHS',
      accountnumber: env.moolre.accountNumber,
    })
  },

  /** 3. CHECK PAYMENT STATUS. txstatus: 1=success, 0=pending, 2=failed */
  async checkStatus(externalref: string): Promise<MoolreResult> {
    return call('POST', '/open/transact/status', 'public', {
      type: 1,
      idtype: '1',
      id: externalref,
      accountnumber: env.moolre.accountNumber,
    })
  },

  /** 4. VALIDATE RECIPIENT — confirm a MoMo number is active. Returns the account name. */
  async validateRecipient(args: { receiver: string; network: MomoNetwork }): Promise<MoolreResult<string>> {
    return call('POST', '/open/transact/validate', 'private', {
      type: 1,
      receiver: args.receiver,
      channel: CHANNEL.transfer[args.network],
      currency: 'GHS',
      accountnumber: env.moolre.accountNumber,
    })
  },

  /** 5. DISBURSEMENT — pay a farmer instantly (private key). */
  async transfer(args: {
    network: MomoNetwork
    amount: number
    receiver: string
    externalref: string
    reference: string
  }): Promise<MoolreResult> {
    return call('POST', '/open/transact/transfer', 'private', {
      type: 1,
      channel: CHANNEL.transfer[args.network],
      currency: 'GHS',
      amount: money(args.amount),
      receiver: args.receiver,
      externalref: args.externalref,
      reference: args.reference,
      accountnumber: env.moolre.accountNumber,
    })
  },

  /** 6. TRANSFER STATUS. */
  async transferStatus(externalref: string): Promise<MoolreResult> {
    return call('POST', '/open/transact/status', 'private', {
      type: 1,
      idtype: '1',
      id: externalref,
      accountnumber: env.moolre.accountNumber,
    })
  },

  /** 7. SEND SMS (single, GET with URL-encoded message). */
  async sendSms(recipient: string, message: string): Promise<MoolreResult> {
    return call('GET', '/open/sms/send', 'vas', undefined, {
      type: '1',
      senderid: env.moolre.senderId,
      recipient,
      message, // axios URL-encodes params
    })
  },

  /** 7b. SEND BULK SMS (POST with messages array). */
  async sendBulkSms(messages: { recipient: string; message: string; ref: string }[]): Promise<MoolreResult> {
    return call('POST', '/open/sms/send', 'vas', {
      type: 1,
      senderid: env.moolre.senderId,
      messages,
    })
  },

  /** 8. ACCOUNT BALANCE. */
  async accountBalance(): Promise<MoolreResult> {
    return call('POST', '/open/account/status', 'private', {
      type: 1,
      accountnumber: env.moolre.accountNumber,
    })
  },
}
