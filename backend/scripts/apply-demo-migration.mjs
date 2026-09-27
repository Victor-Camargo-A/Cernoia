import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});
await client.connect();
try {
  await client.query(await readFile(new URL("../sql/031_demo_access.sql", import.meta.url), "utf8"));
  console.log("Migración 031_demo_access.sql aplicada correctamente.");
} finally {
  await client.end();
}
