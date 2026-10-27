import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { Sql } from "./db.ts";
import * as service from "./service.ts";
import type { Result } from "./service.ts";

type Options = { sql: Sql; apiKey: string; pageHtml: string };

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Compares keys in constant time so the response time doesn't leak the key. */
function keyMatches(given: string | undefined, expected: string) {
  return given !== undefined && timingSafeEqual(digest(given), digest(expected));
}

function send(c: Context, result: Result) {
  for (const [name, value] of Object.entries(result.headers ?? {})) c.header(name, value);
  return c.json(result.body as object, result.status as 200);
}

/** Reads a JSON body; returns undefined when it isn't valid JSON. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createApp({ sql, apiKey, pageHtml }: Options) {
  const app = new Hono();

  // The web page and its /ui routes are public; the server adds the API key for them,
  // so the key never reaches the browser.
  app.get("/", (c) => c.html(pageHtml));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/ui/slots", async (c) => send(c, await service.listSlots(sql, undefined)));
  app.post("/ui/bookings", async (c) => {
    const body = await readJson(c);
    if (body === undefined) return c.json({ error: "body must be valid JSON" }, 400);
    return send(c, await service.createBooking(sql, body, c.req.header("Idempotency-Key")));
  });
  app.get("/ui/bookings/:id", async (c) => send(c, await service.getBooking(sql, c.req.param("id"))));

  // Level 2: every API request needs the X-API-Key header.
  app.use("*", async (c, next) => {
    if (!keyMatches(c.req.header("X-API-Key"), apiKey)) return c.json({ error: "missing or invalid API key" }, 401);
    await next();
  });

  app.post("/reset", async (c) => send(c, await service.resetSlots(sql, await readJson(c))));
  app.get("/slots", async (c) => send(c, await service.listSlots(sql, c.req.query("provider"))));

  app.post("/bookings", async (c) => {
    const body = await readJson(c);
    if (body === undefined) return c.json({ error: "body must be valid JSON" }, 400);
    return send(c, await service.createBooking(sql, body, c.req.header("Idempotency-Key")));
  });
  app.get("/bookings", async (c) =>
    send(c, await service.listBookings(sql, {
      email: c.req.query("email"),
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    })),
  );
  app.get("/bookings/:id", async (c) => send(c, await service.getBooking(sql, c.req.param("id"))));
  app.delete("/bookings/:id", async (c) => send(c, await service.cancelBooking(sql, c.req.param("id"))));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}
