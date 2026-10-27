import { createHash } from "node:crypto";
import postgres from "postgres";
import type { Sql } from "./db.ts";

/** What a handler sends back: status code, JSON body and optional headers. */
export type Result = { status: number; body: unknown; headers?: Record<string, string> };

const ok = (body: unknown, status = 200): Result => ({ status, body });
const fail = (status: number, error: string, headers?: Record<string, string>): Result => ({
  status,
  body: { error },
  headers,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60;

type BookingRow = {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: Date;
};

function toBooking(row: BookingRow) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isUniqueViolation = (e: unknown) => e instanceof postgres.PostgresError && e.code === "23505";

/** JSON with keys sorted, so {"a":1,"b":2} and {"b":2,"a":1} count as the same body. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------- Level 1: reset and slots ----------

export async function resetSlots(sql: Sql, body: unknown): Promise<Result> {
  if (!isObject(body) || !Array.isArray(body.slots)) return fail(400, "slots must be an array");

  const slots: { id: string; provider: string; start_at: Date; end_at: Date; start_raw: string; end_raw: string }[] = [];
  const seen = new Set<string>();
  for (const s of body.slots) {
    if (!isObject(s)) return fail(400, "each slot must be an object");
    const { id, provider, start, end } = s;
    if (typeof id !== "string" || !id || typeof provider !== "string" || !provider) {
      return fail(400, "each slot needs an id and provider");
    }
    if (typeof start !== "string" || typeof end !== "string" || isNaN(Date.parse(start)) || isNaN(Date.parse(end))) {
      return fail(400, "each slot needs a valid start and end");
    }
    if (seen.has(id)) return fail(400, `duplicate slot id ${id}`);
    seen.add(id);
    slots.push({ id, provider, start_at: new Date(start), end_at: new Date(end), start_raw: start, end_raw: end });
  }

  await sql.begin(async (tx) => {
    await tx`truncate bookings, slots, idempotency_keys, booking_attempts restart identity`;
    if (slots.length) await tx`insert into slots ${tx(slots)}`;
  });
  return ok({ slots: slots.length });
}

export async function listSlots(sql: Sql, provider: string | undefined): Promise<Result> {
  const rows = await sql<{ id: string; provider: string; start_raw: string; end_raw: string; available: boolean }[]>`
    select s.id, s.provider, s.start_raw, s.end_raw,
           not exists (select 1 from bookings b where b.slot_id = s.id and b.status = 'confirmed') as available
    from slots s
    where ${provider === undefined ? sql`true` : sql`s.provider = ${provider}`}
    order by s.start_at, s.id
  `;
  return ok({
    slots: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_raw,
      end: r.end_raw,
      available: r.available,
    })),
  });
}

// ---------- Levels 1–5: create a booking ----------

export async function createBooking(sql: Sql, body: unknown, idempotencyKey: string | undefined): Promise<Result> {
  const requestHash = createHash("sha256").update(canonicalJson(body)).digest("hex");

  // Everything happens in one transaction, so the booking, the rate-limit
  // attempt and the saved idempotent response are committed together.
  return sql.begin(async (tx) => {
    // Level 4: a repeated key returns the saved response instead of booking again.
    // The advisory lock makes two requests with the same key wait for each other.
    if (idempotencyKey !== undefined) {
      await tx`select pg_advisory_xact_lock(hashtextextended(${"idem:" + idempotencyKey}, 0))`;
      const [saved] = await tx<{ request_hash: string; status: number; body: unknown }[]>`
        select request_hash, status, body from idempotency_keys where key = ${idempotencyKey}
      `;
      if (saved) {
        if (saved.request_hash !== requestHash) return fail(422, "Idempotency-Key was already used with a different body");
        return { status: saved.status, body: saved.body };
      }
    }

    const result = await attemptBooking(tx, body);

    // Save the response for this key. Rate-limit responses aren't saved, so a retry
    // after waiting gets a real answer.
    if (idempotencyKey !== undefined && result.status !== 429) {
      await tx`
        insert into idempotency_keys (key, request_hash, status, body)
        values (${idempotencyKey}, ${requestHash}, ${result.status}, ${tx.json(result.body as postgres.JSONValue)})
      `;
    }
    return result;
  });
}

async function attemptBooking(tx: postgres.TransactionSql, body: unknown): Promise<Result> {
  const fields = isObject(body) ? body : {};
  const email = typeof fields.email === "string" ? fields.email.trim().toLowerCase() : "";

  // Level 5: at most 5 attempts per email per minute, failed ones included.
  if (email) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${"rate:" + email}, 0))`;
    // Seconds until the oldest attempt leaves the window, worked out with the database clock.
    const [window] = await tx<{ attempts: number; retry_after: number | null }[]>`
      select count(*)::int as attempts,
             ceil(extract(epoch from min(at) + make_interval(secs => ${RATE_WINDOW_SECONDS}) - clock_timestamp()))::int
               as retry_after
      from booking_attempts
      where email = ${email} and at > clock_timestamp() - make_interval(secs => ${RATE_WINDOW_SECONDS})
    `;
    if (window.attempts >= RATE_LIMIT) {
      const retryAfter = Math.max(1, window.retry_after ?? RATE_WINDOW_SECONDS);
      return fail(429, "too many booking attempts for this email, try again later", { "Retry-After": String(retryAfter) });
    }
    await tx`insert into booking_attempts (email) values (${email})`;
  }

  // Level 2: validation.
  if (!isObject(body)) return fail(400, "body must be a JSON object");
  const slotId = typeof body.slot_id === "string" ? body.slot_id.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!slotId) return fail(400, "slot_id is required");
  if (!name) return fail(400, "name is required");
  if (!email) return fail(400, "email is required");
  if (!EMAIL_RE.test(email)) return fail(400, "email is not valid");

  const [slot] = await tx<{ started: boolean }[]>`
    select start_at <= now() as started from slots where id = ${slotId}
  `;
  if (!slot) return fail(404, "slot not found");
  if (slot.started) return fail(400, "slot has already started");

  // Level 3: the unique index rejects a second confirmed booking. The savepoint
  // keeps the transaction usable so we can still save the 409 response.
  try {
    const [row] = await tx.savepoint((sp) => sp<BookingRow[]>`
      insert into bookings (slot_id, name, email, status)
      values (${slotId}, ${name}, ${email}, 'confirmed')
      returning id, slot_id, name, email, status, created_at
    `);
    return ok(toBooking(row), 201);
  } catch (error) {
    if (isUniqueViolation(error)) return fail(409, "slot is already booked");
    throw error;
  }
}

// ---------- Level 1 + 3: look up and cancel ----------

export async function getBooking(sql: Sql, id: string): Promise<Result> {
  if (!UUID_RE.test(id)) return fail(404, "booking not found");
  const [row] = await sql<BookingRow[]>`
    select id, slot_id, name, email, status, created_at from bookings where id = ${id}
  `;
  return row ? ok(toBooking(row)) : fail(404, "booking not found");
}

export async function cancelBooking(sql: Sql, id: string): Promise<Result> {
  if (!UUID_RE.test(id)) return fail(404, "booking not found");
  // Only a confirmed booking can move to cancelled, so two cancels can't both succeed.
  const [row] = await sql<BookingRow[]>`
    update bookings set status = 'cancelled'
    where id = ${id} and status = 'confirmed'
    returning id, slot_id, name, email, status, created_at
  `;
  if (row) return ok(toBooking(row));
  const [exists] = await sql`select 1 from bookings where id = ${id}`;
  return exists ? fail(409, "booking is already cancelled") : fail(404, "booking not found");
}

// ---------- Level 4: a person's bookings, cursor paginated ----------

const encodeCursor = (seq: string) => Buffer.from(seq).toString("base64url");
function decodeCursor(cursor: string): string | null {
  const seq = Buffer.from(cursor, "base64url").toString();
  return /^\d{1,18}$/.test(seq) ? seq : null;
}

export async function listBookings(
  sql: Sql,
  query: { email?: string; limit?: string; cursor?: string },
): Promise<Result> {
  const email = query.email?.trim().toLowerCase();
  if (!email) return fail(400, "email is required");

  let limit = 10;
  if (query.limit !== undefined) {
    if (!/^\d+$/.test(query.limit)) return fail(400, "limit must be a whole number from 1 to 50");
    limit = Number(query.limit);
    if (limit < 1 || limit > 50) return fail(400, "limit must be a whole number from 1 to 50");
  }

  let after = "0";
  if (query.cursor !== undefined && query.cursor !== "") {
    const seq = decodeCursor(query.cursor);
    if (seq === null) return fail(400, "cursor is not valid");
    after = seq;
  }

  // Fetch one extra row to know whether there's another page.
  const rows = await sql<(BookingRow & { seq: string })[]>`
    select seq, id, slot_id, name, email, status, created_at
    from bookings
    where email = ${email} and seq > ${after}
    order by seq
    limit ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return ok({
    bookings: page.map(toBooking),
    next_cursor: hasMore ? encodeCursor(String(page[page.length - 1].seq)) : null,
  });
}
