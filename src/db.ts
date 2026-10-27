import postgres from "postgres";

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  // prepare: false — hosted poolers like Neon's (PgBouncer) don't support prepared statements.
  return postgres(url, { max: 10, prepare: false, onnotice: () => {} });
}

/** Creates the tables if they don't exist yet. Safe to run on every start. */
export async function migrate(sql: Sql) {
  await sql.unsafe(`
    create table if not exists slots (
      id       text primary key,
      provider text not null,
      start_at timestamptz not null,
      end_at   timestamptz not null,
      start_raw text not null,                    -- returned exactly as sent to /reset
      end_raw   text not null
    );

    create table if not exists bookings (
      seq        bigserial unique,                -- insertion order, used for paging
      id         uuid primary key default gen_random_uuid(),
      slot_id    text not null references slots (id) on delete cascade,
      name       text not null,
      email      text not null,                   -- stored lower case
      status     text not null check (status in ('confirmed', 'cancelled')),
      created_at timestamptz not null default clock_timestamp()
    );

    -- Level 3: the database itself refuses a second confirmed booking for a slot,
    -- so two requests at the same moment can't both win.
    create unique index if not exists one_confirmed_booking_per_slot
      on bookings (slot_id) where status = 'confirmed';
    create index if not exists bookings_email_seq on bookings (email, seq);

    -- Level 4: the first response for each Idempotency-Key.
    create table if not exists idempotency_keys (
      key          text primary key,
      request_hash text not null,
      status       int not null,
      body         jsonb not null,
      created_at   timestamptz not null default now()
    );

    -- Level 5: one row per booking attempt.
    create table if not exists booking_attempts (
      email text not null,
      at    timestamptz not null default clock_timestamp()
    );
    create index if not exists booking_attempts_email_at on booking_attempts (email, at);
  `);
}
