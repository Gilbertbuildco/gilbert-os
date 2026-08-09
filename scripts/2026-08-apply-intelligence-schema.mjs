// Idempotent schema migration for the invoice-intelligence upgrade.
// Adds audit/normalisation columns to existing tables and creates the two
// learning tables (supplier_aliases, classification_mappings) plus the unique
// indexes the ON CONFLICT upserts in the app depend on.
//
// Safe to run repeatedly: every statement uses IF [NOT] EXISTS.
//
// Run with:
//   node --env-file-if-exists=/vercel/share/.env.project scripts/2026-08-apply-intelligence-schema.mjs

import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const statements = [
  // --- products: structured normalisation -------------------------------
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS normalised_name text`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS product_family text`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type text`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS dimensions text`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS thickness text`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory text`,

  // --- invoices: audit + credit linking ---------------------------------
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS extraction_raw jsonb`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS confidence text`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credit_of_invoice_id integer`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reconciled boolean NOT NULL DEFAULT true`,

  // --- invoice_line_items: raw + normalised ------------------------------
  `ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS raw_description text`,
  `ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS raw_unit text`,
  `ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS normalised_unit text`,
  `ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS is_price_tracked boolean NOT NULL DEFAULT true`,

  // --- price_records: normalised unit ------------------------------------
  `ALTER TABLE price_records ADD COLUMN IF NOT EXISTS normalised_unit text`,

  // --- supplier_aliases --------------------------------------------------
  `CREATE TABLE IF NOT EXISTS supplier_aliases (
     id serial PRIMARY KEY,
     supplier_id integer NOT NULL,
     normalised_name text NOT NULL,
     raw_name text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  // One alias per normalised heading — the ON CONFLICT target for alias learning.
  `CREATE UNIQUE INDEX IF NOT EXISTS supplier_aliases_normalised_name_key
     ON supplier_aliases (normalised_name)`,

  // --- classification_mappings -------------------------------------------
  `CREATE TABLE IF NOT EXISTS classification_mappings (
     id serial PRIMARY KEY,
     key_kind text NOT NULL,
     key_value text NOT NULL,
     supplier_id integer,
     product_id integer,
     cost_package_code text,
     cost_package_name text,
     category text,
     normalised_unit text,
     track_as_product boolean,
     times_confirmed integer NOT NULL DEFAULT 1,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  // Unique per (kind, key, supplier) — supplier NULL collapses to 0 so global
  // and supplier-specific mappings never collide. Matches the app's upsert.
  `CREATE UNIQUE INDEX IF NOT EXISTS classification_mappings_key_supplier_key
     ON classification_mappings (key_kind, key_value, (coalesce(supplier_id, 0)))`,
]

async function main() {
  const client = await pool.connect()
  try {
    for (const sql of statements) {
      await client.query(sql)
      console.log("[migrate] ok:", sql.split("\n")[0].trim().slice(0, 70))
    }
    console.log("[migrate] all statements applied successfully")
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error("[migrate] failed:", e)
  process.exit(1)
})
