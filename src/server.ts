import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { connect, migrate } from "./db.ts";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const sql = connect(required("DATABASE_URL"));
await migrate(sql);

const app = createApp({
  sql,
  apiKey: required("API_KEY"),
  pageHtml: readFileSync(new URL("../public/index.html", import.meta.url), "utf8"),
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`Listening on http://localhost:${port}`));
