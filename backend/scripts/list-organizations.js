import "dotenv/config";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL en backend/.env");

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

await client.connect();
try {
  const result = await client.query(
    `SELECT id, name, slug, status
     FROM saas.organizations
     ORDER BY name ASC`,
  );
  if (!result.rowCount) {
    console.log("No hay organizaciones registradas en saas.organizations.");
  } else {
    console.table(result.rows);
  }
} finally {
  await client.end();
}
