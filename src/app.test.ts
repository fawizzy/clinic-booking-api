import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { connect, migrate } from "./db.ts";

const KEY = "test-key";
const sql = connect(process.env.TEST_DATABASE_URL ?? "postgres://owner:owner_dev_password@127.0.0.1:15441/booking");
const app = createApp({ sql, apiKey: KEY, pageHtml: "<h1>page</h1>" });

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const SLOTS = [
  { id: "s2", provider: "Dr Bello", start: hoursFromNow(26), end: hoursFromNow(26.5) },
  { id: "s1", provider: "Dr Ade", start: hoursFromNow(24), end: hoursFromNow(24.5) },
  { id: "past", provider: "Dr Ade", start: hoursFromNow(-2), end: hoursFromNow(-1.5) },
];

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const book = (body: unknown, headers?: Record<string, string>) => call("POST", "/bookings", body, headers);
const ada = { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" };

beforeAll(() => migrate(sql));
beforeEach(async () => {
  expect((await call("POST", "/reset", { slots: SLOTS })).status).toBe(200);
});
afterAll(() => sql.end());

describe("level 1", () => {
  it("lists slots earliest first with availability, filtered by provider", async () => {
    const res = await call("GET", "/slots");
    const { slots } = await res.json();
    expect(slots.map((s: { id: string }) => s.id)).toEqual(["past", "s1", "s2"]);
    expect(slots[1]).toEqual({ ...SLOTS[1], available: true });

    const filtered = await (await call("GET", "/slots?provider=Dr%20Bello")).json();
    expect(filtered.slots.map((s: { id: string }) => s.id)).toEqual(["s2"]);
  });

  it("books a slot and looks the booking up", async () => {
    const res = await book(ada);
    expect(res.status).toBe(201);
    const booking = await res.json();
    expect(booking).toMatchObject({ ...ada, status: "confirmed" });
    expect(new Date(booking.created_at).toISOString()).toBe(booking.created_at);

    const found = await call("GET", `/bookings/${booking.id}`);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(booking);

    const slots = (await (await call("GET", "/slots")).json()).slots;
    expect(slots.find((s: { id: string }) => s.id === "s1").available).toBe(false);
    expect((await call("GET", "/bookings/not-a-real-id")).status).toBe(404);
  });

  it("reset deletes bookings", async () => {
    const { id } = await (await book(ada)).json();
    await call("POST", "/reset", { slots: SLOTS });
    expect((await call("GET", `/bookings/${id}`)).status).toBe(404);
  });
});

describe("level 2", () => {
  it("rejects missing or wrong API keys on every endpoint", async () => {
    for (const [method, path] of [["GET", "/slots"], ["POST", "/reset"], ["POST", "/bookings"], ["GET", "/bookings?email=a@b.co"]]) {
      expect((await app.request(path, { method })).status).toBe(401);
      expect((await call(method, path, undefined, { "X-API-Key": "wrong" })).status).toBe(401);
    }
    const res = await app.request("/slots");
    expect(await res.json()).toEqual({ error: "missing or invalid API key" });
  });

  it.each([
    ["missing slot_id", { name: "Ada", email: "ada@example.com" }],
    ["empty name", { ...ada, name: "   " }],
    ["missing email", { slot_id: "s1", name: "Ada" }],
    ["invalid email", { ...ada, email: "not-an-email" }],
    ["non-string name", { ...ada, name: 42 }],
  ])("returns 400 for %s", async (_, body) => {
    const res = await book(body);
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  it("returns 400 for invalid JSON, 404 for unknown slots and 400 for started slots", async () => {
    expect((await book("{nope")).status).toBe(400);
    expect((await book({ ...ada, slot_id: "nope" })).status).toBe(404);
    expect((await book({ ...ada, slot_id: "past" })).status).toBe(400);
  });

  it("trims name and email and lower-cases email", async () => {
    const res = await book({ slot_id: "s1", name: "  Ada Obi ", email: "  ADA@Example.COM " });
    expect(await res.json()).toMatchObject({ name: "Ada Obi", email: "ada@example.com" });
  });
});

describe("level 3", () => {
  it("never double-books, even with many requests at the same moment", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => book({ ...ada, email: `p${i}@example.com` })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    const [{ count }] = await sql`select count(*)::int from bookings where status = 'confirmed'`;
    expect(count).toBe(1);
  });

  it("cancels a booking, frees the slot, and refuses a second cancel", async () => {
    const { id } = await (await book(ada)).json();
    expect((await book({ ...ada, email: "bola@example.com" })).status).toBe(409);

    const cancelled = await call("DELETE", `/bookings/${id}`);
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).status).toBe("cancelled");
    expect((await call("DELETE", `/bookings/${id}`)).status).toBe(409);
    expect((await call("DELETE", "/bookings/00000000-0000-0000-0000-000000000000")).status).toBe(404);

    expect((await book({ ...ada, email: "bola@example.com" })).status).toBe(201);
  });
});

describe("level 4", () => {
  it("replays the same response for a repeated Idempotency-Key", async () => {
    const first = await book(ada, { "Idempotency-Key": "k1" });
    const second = await book(ada, { "Idempotency-Key": "k1" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await second.json()).id).toBe((await first.json()).id);
    const [{ count }] = await sql`select count(*)::int from bookings`;
    expect(count).toBe(1);
  });

  it("replays error responses too, and treats key order as the same body", async () => {
    await book(ada);
    const first = await book({ ...ada, email: "bola@example.com" }, { "Idempotency-Key": "k2" });
    const again = await book({ email: "bola@example.com", name: "Ada Obi", slot_id: "s1" }, { "Idempotency-Key": "k2" });
    expect(first.status).toBe(409);
    expect(again.status).toBe(409);
  });

  it("returns 422 when the key is reused with a different body", async () => {
    await book(ada, { "Idempotency-Key": "k3" });
    expect((await book({ ...ada, slot_id: "s2" }, { "Idempotency-Key": "k3" })).status).toBe(422);
  });

  it("creates one booking when the same key arrives many times at once", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => book(ada, { "Idempotency-Key": "k4" })));
    const ids = new Set(await Promise.all(results.map(async (r) => (await r.json()).id)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("pages through a person's bookings oldest first, ignoring email case", async () => {
    const slots = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, provider: "Dr Ade", start: hoursFromNow(30 + i), end: hoursFromNow(30.5 + i) }));
    await call("POST", "/reset", { slots });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      // Different emails per slot would trip the rate limit otherwise; this person books 5 times.
      ids.push((await (await book({ slot_id: `p${i}`, name: "Ada", email: "Ada@Example.com" })).json()).id);
    }
    await book({ slot_id: "p0", name: "Other", email: "other@example.com" });

    const seen = [];
    let cursor: string | null = null;
    do {
      const res = await call("GET", `/bookings?email=ADA@example.com&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const page = await res.json();
      expect(page.bookings.length).toBeLessThanOrEqual(2);
      seen.push(...page.bookings.map((b: { id: string }) => b.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(ids);

    const all = await (await call("GET", "/bookings?email=ada@example.com")).json();
    expect(all.bookings).toHaveLength(5);
    expect(all.next_cursor).toBeNull();
  });

  it.each(["0", "51", "abc", "2.5", "-1"])("rejects limit=%s", async (limit) => {
    expect((await call("GET", `/bookings?email=ada@example.com&limit=${limit}`)).status).toBe(400);
  });

  it("requires an email and a valid cursor", async () => {
    expect((await call("GET", "/bookings")).status).toBe(400);
    expect((await call("GET", "/bookings?email=ada@example.com&cursor=%%%")).status).toBe(400);
  });
});

describe("level 5", () => {
  it("allows 5 attempts per email per minute, counting failures, then 429 with Retry-After", async () => {
    expect((await book(ada)).status).toBe(201);
    for (let i = 0; i < 4; i++) expect((await book(ada)).status).toBe(409); // failed attempts count
    const limited = await book({ ...ada, email: " ADA@example.com " });
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // Other emails aren't affected.
    expect((await book({ ...ada, slot_id: "s2", email: "bola@example.com" })).status).toBe(201);
  });

  it("holds under concurrent attempts", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => book({ ...ada, email: "spam@example.com" })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });
});
