# Clinic booking API

A booking API for a clinic plus a small web page that uses it. Built for Task 1 of the Koya Cohort 4 assessment, following the spec at koyaacademy.com/assessment-api.

**Stack:** Node 22 · TypeScript · [Hono](https://hono.dev) · PostgreSQL ([postgres.js](https://github.com/porsager/postgres)) · Vitest

## Run it

```bash
pnpm install
cp .env.example .env        # set DATABASE_URL and API_KEY
pnpm build && pnpm start    # tables are created on start
pnpm test                   # needs a Postgres database (TEST_DATABASE_URL)
```

The web page is at `/`. Every API endpoint needs the `X-API-Key` header.

## How each level works

| Level | Requirement | How |
|---|---|---|
| 1 | List slots, book, look up | `src/service.ts`. Slot times are returned exactly as sent to `/reset`. |
| 2 | API key, validation | Middleware compares `X-API-Key` in constant time. Bookings are validated in order (400 → 404 → 400 if started); name and email are trimmed, email is lower-cased. |
| 3 | No double booking, cancel | A **partial unique index** on `bookings(slot_id) where status = 'confirmed'`. The database rejects the second insert even if two requests arrive at the same instant, and that becomes a 409. Cancelling only updates a booking that's still confirmed, so the slot frees up and a second cancel returns 409. |
| 4 | Idempotency, paging | The first response for each `Idempotency-Key` is saved with a hash of the body (keys sorted). Repeats get the saved status and body; a different body gets 422. A transaction-scoped **advisory lock** on the key makes simultaneous retries wait instead of racing. Paging uses an opaque cursor over an insertion-order column, so pages don't skip or repeat rows when new bookings arrive. |
| 5 | Rate limit | Every attempt (failed ones too) is recorded per email. More than 5 in a sliding 60-second window returns 429 with `Retry-After` in whole seconds, computed from the oldest attempt in the window. An advisory lock per email stops parallel requests from slipping past the count. |

Everything for one booking request (rate-limit record, booking insert, saved idempotent response) runs in **one transaction**, so it all commits together or not at all.

The web page never sees the API key: it calls `/ui/*` routes on the same server, which run the same booking logic (including the rate limit).

## Tests

`src/app.test.ts` covers every level against a real Postgres database, including 20 simultaneous bookings for one slot (exactly one wins), 10 simultaneous requests with the same idempotency key (one booking), and concurrent rate-limit attempts.
