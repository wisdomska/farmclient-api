# FarmClient API

Backend for **FarmClient** — an AI-powered agricultural marketplace and farmer-finance platform for
Ghana, built on **Moolre**'s payment rails (Collections, Disbursements, SMS, USSD). Implements the
SRS (FR-01 … FR-13): farmer registration, harvest listings, buyer orders with escrow, instant farmer
payouts, the `*789#` USSD interface, FarmScore credit scoring, harvest-advance loans, SMS
notifications, an admin dashboard API and scheduled jobs.

> Companion services: **`farmclient`** (Vite React buyer/marketplace frontend) and **`farmclient-ai`**
> (Python FastAPI price-intelligence microservice).

## Stack

Node 20 · Express 4 · TypeScript · Prisma · PostgreSQL 16 · Upstash Redis · Firebase Admin (Google /
Phone auth) · Moolre APIs · node-cron.

## Architecture

```
src/
  config/      env, prisma, redis (Upstash + in-memory dev fallback), firebase, constants
  middleware/  auth (Firebase→JWT, requireAuth/requireRole), rateLimit (Redis), error
  services/
    moolre.service.ts    all 8 Moolre endpoints (auth headers, retry+backoff, sandbox)
    sms.service.ts       9 SMS templates + Moolre VAS send + sms_log
    payment.service.ts   escrow init, payment links, payout (validate→transfer), webhooks,
                         loan auto-repayment, idempotency, transaction audit log
    price.service.ts     AI price client + rolling-average fallback (graceful degradation)
    score.service.ts     FarmScore (0–1000) calculation
    auth.service.ts      Google / Phone sign-in → find-or-create → JWT
    ussd.service.ts      Redis-backed USSD state machine (register, list, prices, orders,
                         wallet, loan)
  routes/      auth, farmers, listings, orders, payments, prices, loans, admin, ussd, webhooks
  jobs/        cron: price alerts, expire listings, auto-confirm deliveries, retrain, balance check
  app.ts       Express wiring   server.ts   bootstrap
prisma/        schema.prisma (farmers, buyers, agents, listings, orders, transactions, loans,
               sms_log, price_history, audit_log)  +  seed.ts
```

## Moolre integration (SRS FR-06/08/11)

| Flow | Endpoint | Key |
| --- | --- | --- |
| Collection (escrow) | `POST /open/transact/payment` | private |
| Payment link | `POST /embed/link` | public |
| Status | `POST /open/transact/status` | public/private |
| Validate recipient | `POST /open/transact/validate` | private |
| Disbursement (payout) | `POST /open/transact/transfer` | private |
| SMS | `GET/POST /open/sms/send` | VAS |
| Account balance | `POST /open/account/status` | private |

- **Idempotency:** every Moolre call is keyed by a unique `externalref` (order ref / `PAYOUT-{ref}`);
  duplicates return the existing transaction instead of double-charging.
- **Retry:** 3 attempts, exponential backoff (1s/2s/4s).
- **Audit:** request/response/latency logged to the `transactions` table; state changes to `audit_log`.
- **Webhooks** (`/webhook/moolre/collection`, `/webhook/moolre/disbursement`) return `200` immediately
  and process asynchronously. Optional `x-moolre-signature` check via `WEBHOOK_SECRET`.
- **Sandbox:** set `USE_SANDBOX=true` — calls go to `sandbox.moolre.com` and only `X-API-USER` is sent.

## Getting started

```bash
cp .env.example .env        # fill in Moolre, Firebase, DATABASE_URL, Redis
npm install
npx prisma generate
npx prisma migrate dev      # create the schema (needs a running PostgreSQL)
npm run seed                # demo farmer/buyer/listing + seed price history
npm run dev                 # http://localhost:3001  (GET /health)
```

Run the AI service alongside (`farmclient-ai`, port 8000) so `/v1/prices` resolves live; otherwise the
API falls back to the rolling 7-day average from `price_history`.

### What runs without external infrastructure

- The server boots and serves `/health` with no DB/Redis/Firebase configured (Redis uses an in-memory
  dev fallback; Firebase verification is disabled until credentials are set).
- `/v1/prices` works against the AI service or the DB fallback.
- Live **Moolre / Firebase / Postgres** flows require real credentials + a database (see `.env.example`).

## API surface (`/v1`, SRS §6.2)

`auth` (google, verify, phone, refresh) · `farmers` (register, profile, score, stats) ·
`listings` (CRUD + marketplace search) · `orders` (place, confirm, deliver, receive, dispute, pin) ·
`payments` (initiate, payout, status, link) · `prices` (current, history, forecast, regional) ·
`loans` (eligibility, request, status) · `admin` (users, orders, analytics, sms log, broadcast) ·
`POST /ussd` · `POST /webhook/moolre/{collection,disbursement}`.

## Security

Private Moolre key is backend-only. Rate limits: `/ussd` 100/min per session, `/payments/*` 10/min per
user. USSD input sanitised; Ghana Card hashed (Act 843); JWT 24h; HTTPS in production. See the SRS
non-functional requirements for the full list.
