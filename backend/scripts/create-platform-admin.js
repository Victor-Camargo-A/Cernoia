import "dotenv/config";
import pg from "pg";
import { hashPassword } from "../src/security.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, ...value] = item.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);

const email = String(args.email ?? "").trim().toLowerCase();
const name = String(args.name ?? "").trim();
const password = String(args.password ?? process.env.CERNOIA_PLATFORM_PASSWORD ?? "");

if (!email || !name || !password) {
  console.error('Uso: define CERNOIA_PLATFORM_PASSWORD y ejecuta npm run create-platform-admin -- --email=admin@cernoia.com --name="Administrador CernoIA"');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

await client.connect();
try {
  const passwordHash = await hashPassword(password);
  const result = await client.query(
    `INSERT INTO saas.platform_admin_users (email, full_name, password_hash, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT ((LOWER(email))) DO UPDATE
       SET full_name = EXCLUDED.full_name,
           password_hash = EXCLUDED.password_hash,
           status = 'active',
           updated_at = NOW()
     RETURNING id, email, full_name, status`,
    [email, name, passwordHash],
  );
  console.log("Administrador global listo:", result.rows[0]);
} finally {
  await client.end();
}
