import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Falta DATABASE_URL en backend/.env");

const root = dirname(fileURLToPath(import.meta.url));
const sqlDirectory = join(root, "../sql");
const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

await client.connect();
try {
  const migrations = (await readdir(sqlDirectory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort();

  for (const migration of migrations) {
    const sql = await readFile(join(sqlDirectory, migration), "utf8");
    await client.query(sql);
    console.log(`Migración ${migration} aplicada correctamente.`);
  }
} finally {
  await client.end();
}
