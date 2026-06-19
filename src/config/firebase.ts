import admin from 'firebase-admin'
import { env } from './env'

/**
 * Firebase Admin SDK — verifies Google Sign-In / Phone-OTP ID tokens minted on
 * the client. Initialised lazily and tolerant of missing creds in dev.
 */
let initialised = false

export function getFirebaseAuth(): admin.auth.Auth | null {
  if (!initialised) {
    if (!env.firebase.projectId || !env.firebase.clientEmail || !env.firebase.privateKey) {
      if (env.nodeEnv === 'production') {
        throw new Error('Firebase Admin credentials are required in production')
      }
      // eslint-disable-next-line no-console
      console.warn('[firebase] credentials not set — token verification will be unavailable (dev)')
      return null
    }
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: env.firebase.projectId,
          clientEmail: env.firebase.clientEmail,
          privateKey: env.firebase.privateKey,
        }),
      })
    }
    initialised = true
  }
  return admin.auth()
}
