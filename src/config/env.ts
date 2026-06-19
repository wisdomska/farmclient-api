import dotenv from 'dotenv'

dotenv.config()

function required(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback
  if (v === undefined) {
    // In dev we warn rather than crash so the app can boot without every secret.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Missing required env var: ${key}`)
    }
    // eslint-disable-next-line no-console
    console.warn(`[env] warning: ${key} is not set`)
    return ''
  }
  return v
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3001', 10),
  apiUrl: process.env.API_URL ?? 'http://localhost:3001',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '3'),

  jwtSecret: required('JWT_SECRET', 'dev-insecure-secret'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '24h',
  webhookSecret: process.env.WEBHOOK_SECRET ?? '',

  moolre: {
    apiUser: process.env.MOOLRE_API_USER ?? '',
    apiKey: process.env.MOOLRE_API_KEY ?? '',
    pubKey: process.env.MOOLRE_API_PUBKEY ?? '',
    vasKey: process.env.MOOLRE_API_VASKEY ?? '',
    accountNumber: process.env.MOOLRE_ACCOUNT_NUMBER ?? '',
    senderId: process.env.MOOLRE_SENDER_ID ?? 'FarmClient',
    baseUrl: process.env.MOOLRE_BASE_URL ?? 'https://api.moolre.com',
    sandboxUrl: process.env.MOOLRE_SANDBOX_URL ?? 'https://sandbox.moolre.com',
    useSandbox: (process.env.USE_SANDBOX ?? 'true') === 'true',
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
    privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  },

  redis: {
    url: process.env.REDIS_URL ?? '',
    token: process.env.REDIS_TOKEN ?? '',
  },

  aiServiceUrl: process.env.AI_SERVICE_URL ?? 'http://localhost:8000',
  cloudinaryUrl: process.env.CLOUDINARY_URL ?? '',
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
}

/** The active Moolre base URL given the sandbox flag. */
export function moolreBaseUrl(): string {
  return env.moolre.useSandbox ? env.moolre.sandboxUrl : env.moolre.baseUrl
}
