/**
 * `supplier_external_paid` — how much has actually been paid to each supplier
 * according to Xero, cached so a page render never has to call Xero.
 *
 * Why it is needed: several trades are paid without an invoice ever reaching
 * the OS. Rhys Harvey has £12,789 of spend on Xero account 5010 against £2,025
 * of invoices here. Working out what is still to come from invoices alone
 * overstates it by the difference, and the Position page must not do that.
 *
 * Refreshed by scripts/refresh-supplier-paid.mts, which the daily job runs.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  await c.query(`
    CREATE TABLE IF NOT EXISTS supplier_external_paid (
      id             serial PRIMARY KEY,
      supplier_id    integer,
      contact_name   text NOT NULL,
      paid_net       numeric(14,2) NOT NULL DEFAULT 0,
      paid_gross     numeric(14,2) NOT NULL DEFAULT 0,
      transactions   integer NOT NULL DEFAULT 0,
      source         text NOT NULL DEFAULT 'xero',
      refreshed_at   timestamptz NOT NULL DEFAULT now()
    )`)
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS supplier_external_paid_uidx
                   ON supplier_external_paid (source, contact_name)`)
  console.log("supplier_external_paid ready")
  await c.query("COMMIT")
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
