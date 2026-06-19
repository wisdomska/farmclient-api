import { MomoNetwork } from '@prisma/client'

/** The 11 government-designated priority crops (SRS §1). */
export const PRIORITY_CROPS = [
  'Maize',
  'Rice',
  'Soybean',
  'Sorghum',
  'Tomato',
  'Pepper',
  'Onion',
  'Cassava',
  'Yam',
  'Plantain',
  'Broiler Chicken',
] as const

/** USSD crop pick order used in registration / listing menus. */
export const USSD_CROP_ORDER = [
  'Maize',
  'Yam',
  'Cassava',
  'Tomato',
  'Plantain',
  'Rice',
  'Soybean',
  'Sorghum',
  'Pepper',
  'Onion',
] as const

/**
 * Moolre network channel codes.
 *  - transfer (disbursement): MTN=1, Telecel=6, AT=7
 *  - collection (payment request): MTN=13, Telecel=6, AT=7
 */
export const CHANNEL = {
  transfer: { MTN: 1, TELECEL: 6, AIRTELTIGO: 7 } as Record<MomoNetwork, number>,
  collection: { MTN: 13, TELECEL: 6, AIRTELTIGO: 7 } as Record<MomoNetwork, number>,
}

/** Ghanaian MoMo prefixes → network. */
export const NETWORK_PREFIXES: Record<string, MomoNetwork> = {
  '024': 'MTN',
  '025': 'MTN',
  '053': 'MTN',
  '054': 'MTN',
  '055': 'MTN',
  '059': 'MTN',
  '020': 'TELECEL',
  '050': 'TELECEL',
  '026': 'AIRTELTIGO',
  '027': 'AIRTELTIGO',
  '056': 'AIRTELTIGO',
  '057': 'AIRTELTIGO',
}

/** Districts → region mapping (major districts; extend as needed). */
export const DISTRICT_REGION: Record<string, string> = {
  Accra: 'Greater Accra',
  Tema: 'Greater Accra',
  Kumasi: 'Ashanti',
  Obuasi: 'Ashanti',
  Ejisu: 'Ashanti',
  Techiman: 'Bono East',
  Kintampo: 'Bono East',
  Nkoranza: 'Bono East',
  Sunyani: 'Bono',
  Tamale: 'Northern',
  Yendi: 'Northern',
  Bolgatanga: 'Upper East',
  Bawku: 'Upper East',
  Wa: 'Upper West',
  Koforidua: 'Eastern',
  Nkawkaw: 'Eastern',
  Ho: 'Volta',
  Hohoe: 'Volta',
  'Cape Coast': 'Central',
  Kasoa: 'Central',
  Winneba: 'Central',
  Sekondi: 'Western',
  Takoradi: 'Western',
  Tarkwa: 'Western',
  Goaso: 'Ahafo',
  Damongo: 'Savannah',
  Nalerigu: 'North East',
  Sefwi: 'Western North',
  Dambai: 'Oti',
}

export const REGIONS = Array.from(new Set(Object.values(DISTRICT_REGION))).sort()

export function regionForDistrict(district: string): string {
  return DISTRICT_REGION[district.trim()] ?? 'Greater Accra'
}

/** Loan eligibility thresholds (SRS FR-10.2). */
export const LOAN = {
  minScore: 400,
  minOrders: 3,
  offerMultiplier: 0.8, // avg order value × 0.8
  installments: 3,
  maxAmount: 3000,
}

/** USSD constraints. */
export const USSD_SESSION_TTL = 300 // seconds
export const USSD_MAX_LEN = 182
