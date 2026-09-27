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
const organizationId = String(args.organization ?? "").trim();
const password = String(args.password ?? process.env.CERNOIA_ADMIN_PASSWORD ?? "");

if (!email || !name || !organizationId || !password) {
  console.error('Uso: define CERNOIA_ADMIN_PASSWORD y ejecuta npm run create-admin -- --email=admin@dominio.com --name="Nombre" --organization=UUID');
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
    `INSERT INTO saas.app_users (organization_id, email, full_name, password_hash, role, status, password_changed_at)
     VALUES ($1, $2, $3, $4, 'owner', 'active', NOW())
     ON CONFLICT ((lower(email))) DO UPDATE
       SET organization_id = EXCLUDED.organization_id,
           full_name = EXCLUDED.full_name,
           password_hash = EXCLUDED.password_hash, password_changed_at = NOW(),
           role = 'owner', status = 'active', updated_at = NOW()
     RETURNING id, email, full_name, organization_id, role`,
    [organizationId, email, name, passwordHash],
  );
  console.log("Usuario administrador listo:", result.rows[0]);
} finally {
  await client.end();
}
