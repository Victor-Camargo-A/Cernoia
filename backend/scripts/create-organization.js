import "dotenv/config";
import pg from "pg";

const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, ...value] = item.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);

const name = String(args.name ?? "").trim();
const requestedSlug = String(args.slug ?? "").trim();
const slug = (requestedSlug || name)
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 100);

if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL en backend/.env");
if (name.length < 2 || !slug) {
  console.error('Uso: npm run create-organization -- --name="Mi Empresa S.A.S." --slug="mi-empresa"');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

await client.connect();
try {
  const existing = await client.query("SELECT id, name, slug, status FROM saas.organizations WHERE slug = $1", [slug]);
  if (existing.rowCount) {
    console.log("La organización ya existe:", existing.rows[0]);
  } else {
    const result = await client.query(
      `INSERT INTO saas.organizations (name, legal_name, slug, status, metadata)
       VALUES ($1, $1, $2, 'active', jsonb_build_object('created_by', 'cernoia_cli'))
       RETURNING id, name, slug, status`,
      [name, slug],
    );
    console.log("Organización creada. Copia este UUID para crear el propietario:", result.rows[0]);
  }
} finally {
  await client.end();
}
