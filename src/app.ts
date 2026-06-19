import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { env } from './config/env'
import { errorHandler, notFound } from './middleware/error'

import authRoutes from './routes/auth.routes'
import farmerRoutes from './routes/farmers.routes'
import listingRoutes from './routes/listings.routes'
import orderRoutes from './routes/orders.routes'
import paymentRoutes from './routes/payments.routes'
import priceRoutes from './routes/prices.routes'
import loanRoutes from './routes/loans.routes'
import adminRoutes from './routes/admin.routes'
import ussdRoutes from './routes/ussd.routes'
import webhookRoutes from './routes/webhooks.routes'
import jobRoutes from './routes/jobs.routes'
import agentRoutes from './routes/agents.routes'
import uploadRoutes from './routes/uploads.routes'

export function createApp() {
  const app = express()

  app.use(helmet())
  app.use(cors({ origin: env.frontendUrl === '*' ? true : [env.frontendUrl], credentials: true }))
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))
  if (env.nodeEnv !== 'test') app.use(morgan('tiny'))

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'farmclient-api', sandbox: env.moolre.useSandbox }))

  // Versioned API (SRS §6.2) and root mounts (Moolre webhooks/USSD post to root paths).
  app.use('/v1/auth', authRoutes)
  app.use('/v1/farmers', farmerRoutes)
  app.use('/v1/listings', listingRoutes)
  app.use('/v1/orders', orderRoutes)
  app.use('/v1/payments', paymentRoutes)
  app.use('/v1/prices', priceRoutes)
  app.use('/v1/loans', loanRoutes)
  app.use('/v1/admin', adminRoutes)
  app.use('/v1/agents', agentRoutes)
  app.use('/v1/uploads', uploadRoutes)

  // USSD + webhooks mounted at both root and /v1 so Moolre can post to either.
  app.use('/ussd', ussdRoutes)
  app.use('/v1/ussd', ussdRoutes)
  app.use('/webhook', webhookRoutes)
  app.use('/v1/webhook', webhookRoutes)

  // HTTP-triggerable cron tasks (Vercel Cron).
  app.use('/jobs', jobRoutes)
  app.use('/v1/jobs', jobRoutes)

  app.use(notFound)
  app.use(errorHandler)
  return app
}
