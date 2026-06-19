// Vercel serverless entry. All routes are rewritten here (see vercel.json).
// An Express app is itself a (req, res) handler, so we export it directly.
import { createApp } from '../src/app'

const app = createApp()

export default app
