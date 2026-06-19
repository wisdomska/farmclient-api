import { PrismaClient, MomoNetwork, VerificationStatus, Channel, BuyerType, ListingStatus } from '@prisma/client'

const prisma = new PrismaClient()

// Base prices GHS/kg per crop
const BASE_PRICES: Record<string, number> = {
  Yam: 4.2,
  Maize: 1.8,
  Tomato: 6.5,
  Cassava: 1.1,
  Plantain: 3.4,
  Rice: 5.2,
  Pepper: 8.0,
  Onion: 4.8,
  Soybean: 3.9,
  Sorghum: 2.6,
}

const CROPS = Object.keys(BASE_PRICES)

const REGIONS = [
  'Greater Accra',
  'Ashanti',
  'Northern',
  'Bono East',
  'Volta',
  'Central',
  'Eastern',
]

// Small deterministic noise so repeated seeds produce similar data
function noise(seed: number, dayOffset: number): number {
  const x = Math.sin(seed * 9301 + dayOffset * 49297 + 233720) * 10000
  return (x - Math.floor(x)) * 0.3 - 0.15 // +/- 15 % of base
}

async function seedPriceHistory(): Promise<void> {
  console.log('[seed] seeding price_history …')
  let inserted = 0

  for (let c = 0; c < CROPS.length; c++) {
    const crop = CROPS[c]
    const base = BASE_PRICES[crop]

    for (let r = 0; r < REGIONS.length; r++) {
      const region = REGIONS[r]

      for (let day = 10; day >= 1; day--) {
        // slight upward drift: +0.5% per day surviving
        const drift = 1 + 0.005 * (10 - day)
        const rawNoise = noise(c * 100 + r * 10, day)
        const price = Math.round(base * drift * (1 + rawNoise) * 100) / 100
        const recordedAt = new Date(Date.now() - day * 24 * 60 * 60 * 1000)

        await prisma.priceHistory.create({
          data: {
            crop,
            region,
            pricePerKg: price,
            source: 'seed',
            recordedAt,
          },
        })
        inserted++
      }
    }
  }

  console.log(`[seed] price_history — ${inserted} rows inserted`)
}

async function seedDemoFarmer(): Promise<string> {
  console.log('[seed] upserting demo farmer …')

  const existing = await prisma.farmer.findUnique({ where: { phoneNumber: '0244000000' } })
  if (existing) {
    console.log('[seed] demo farmer already exists, skipping create')
    return existing.id
  }

  const farmer = await prisma.farmer.create({
    data: {
      farmvaultId: 'FV-00841',
      fullName: 'Demo Farmer',
      phoneNumber: '0244000000',
      crops: ['Yam', 'Plantain'],
      region: 'Bono East',
      district: 'Techiman',
      momoNumber: '0244000000',
      momoNetwork: MomoNetwork.MTN,
      verification: VerificationStatus.verified,
      farmScore: 812,
      totalOrders: 64,
      totalRevenue: 48250,
      regChannel: Channel.app,
      smsOptIn: true,
    },
  })

  console.log(`[seed] demo farmer created — id=${farmer.id}`)
  return farmer.id
}

async function seedDemoBuyer(): Promise<string> {
  console.log('[seed] upserting demo buyer …')

  const existing = await prisma.buyer.findFirst({ where: { email: 'kwame@goldenfork.gh' } })
  if (existing) {
    console.log('[seed] demo buyer already exists, skipping create')
    return existing.id
  }

  const buyer = await prisma.buyer.create({
    data: {
      fullName: 'Kwame Asante',
      email: 'kwame@goldenfork.gh',
      businessName: 'Golden Fork Restaurant Group',
      businessType: BuyerType.restaurant,
      isVerified: true,
    },
  })

  console.log(`[seed] demo buyer created — id=${buyer.id}`)
  return buyer.id
}

async function seedDemoListing(farmerId: string): Promise<void> {
  console.log('[seed] upserting demo listing …')

  const existing = await prisma.listing.findFirst({
    where: { farmerId, cropType: 'Yam', status: ListingStatus.active },
  })
  if (existing) {
    console.log('[seed] demo listing already exists, skipping create')
    return
  }

  const harvestDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000)
  const expiresAt = new Date(Date.now() + 34 * 24 * 60 * 60 * 1000)

  // Generate a simple listing ref
  const listingRef = `HV-00001`

  const existingRef = await prisma.listing.findUnique({ where: { listingRef } })
  const finalRef = existingRef ? `HV-0${Date.now().toString().slice(-4)}` : listingRef

  await prisma.listing.create({
    data: {
      listingRef: finalRef,
      farmerId,
      cropType: 'Yam',
      quantityKg: 1800,
      qtyRemaining: 1800,
      pricePerKg: 4.20,
      harvestDate,
      district: 'Techiman',
      region: 'Bono East',
      status: ListingStatus.active,
      channel: Channel.app,
      expiresAt,
    },
  })

  console.log(`[seed] demo listing created — ${finalRef}`)
}

async function main(): Promise<void> {
  console.log('[seed] starting …')

  await seedPriceHistory()
  const farmerId = await seedDemoFarmer()
  await seedDemoBuyer()
  await seedDemoListing(farmerId)

  console.log('[seed] done.')
}

main().catch((err) => {
  console.error('[seed] error:', err)
  process.exit(1)
}).finally(async () => {
  await prisma.$disconnect()
})
