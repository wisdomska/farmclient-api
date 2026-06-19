import { Router } from 'express'
import { z } from 'zod'
import { v2 as cloudinary } from 'cloudinary'
import { asyncHandler, HttpError } from '../middleware/error'
import { requireAuth } from '../middleware/auth'
import { prisma } from '../config/prisma'
import { env } from '../config/env'

const router = Router()

// Cloudinary auto-configures from the CLOUDINARY_URL env var
// (cloudinary://<key>:<secret>@<cloud>). Uploads are disabled until it is set.
if (env.cloudinaryUrl) cloudinary.config({ secure: true })

const uploadSchema = z.object({
  // a data URL (data:image/jpeg;base64,...) or a remote https URL
  image: z.string().min(1),
  listingId: z.string().uuid().optional(),
})

// POST /uploads — upload a produce photo to Cloudinary; optionally append the
// resulting CDN URL to a listing's photos[] (SRS FR-02.2: up to 4 photos).
router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!env.cloudinaryUrl) {
      throw new HttpError(501, 'Image upload is not configured. Set CLOUDINARY_URL to enable it.')
    }
    const { image, listingId } = uploadSchema.parse(req.body)

    const result = await cloudinary.uploader.upload(image, {
      folder: 'farmclient/listings',
      resource_type: 'image',
      transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
    })
    const url = result.secure_url

    if (listingId) {
      const listing = await prisma.listing.findUnique({ where: { id: listingId } })
      if (!listing) throw new HttpError(404, 'Listing not found')
      const photos = [...listing.photos, url].slice(0, 4) // cap at 4 (SRS)
      await prisma.listing.update({ where: { id: listingId }, data: { photos } })
    }

    res.status(201).json({ url, publicId: result.public_id })
  }),
)

export default router
