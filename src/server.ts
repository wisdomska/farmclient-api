import { createApp } from './app'
import { env } from './config/env'
import { registerJobs } from './jobs'

const app = createApp()

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`FarmClient API listening on :${env.port} (sandbox=${env.moolre.useSandbox})`)
  registerJobs()
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
