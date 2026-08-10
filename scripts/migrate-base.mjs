/**
 * Idempotent BASE schema migration for Gilbert OS.
 *
 * Reproduces the complete current production schema for a FRESH database:
 * every core table plus the four FUNCTIONAL unique indexes the application code
 * relies on (duplicate-invoice guard, supplier-alias learning, classification
 * learning, project slug). Safe to run repeatedly — only CREATE ... IF NOT
 * EXISTS; never drops or alters existing data.
 *
 * Rebuild order for a fresh DB:
 *   1. node --env-file=.env.development.local scripts/migrate-base.mjs
 *   2. node --env-file=.env.development.local scripts/migrate-funding.mjs
 *
 * Mirrors lib/db/schema.ts. If you change the Drizzle schema, update this file
 * in the same commit so the repo never depends on a "hidden" migration.
 */
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const DDL = [
  `CREATE TABLE IF NOT EXISTS projects (
     id serial PRIMARY KEY,
     slug text NOT NULL UNIQUE,
     name text NOT NULL,
     location text,
     status text NOT NULL DEFAULT 'Planning',
     homes integer,
     build_area_sqft integer,
     original_build_budget numeric,
     development_facility numeric,
     remaining_drawdown numeric,
     expected_gdv numeric,
     land_price numeric,
     build_cost_per_sqft numeric,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS suppliers (
     id serial PRIMARY KEY,
     name text NOT NULL,
     contact text,
     notes text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS products (
     id serial PRIMARY KEY,
     name text NOT NULL,
     description text,
     category text,
     manufacturer text,
     unit text,
     normalised_name text,
     product_family text,
     product_type text,
     dimensions text,
     thickness text,
     subcategory text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS supplier_products (
     id serial PRIMARY KEY,
     product_id integer NOT NULL,
     supplier_id integer NOT NULL,
     supplier_product_code text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS invoices (
     id serial PRIMARY KEY,
     supplier_id integer NOT NULL,
     project_id integer,
     invoice_number text,
     invoice_date date,
     transaction_type text NOT NULL DEFAULT 'invoice',
     net numeric NOT NULL DEFAULT 0,
     vat numeric NOT NULL DEFAULT 0,
     gross numeric NOT NULL DEFAULT 0,
     status text NOT NULL DEFAULT 'confirmed',
     source_file_name text,
     source_file_pathname text,
     source_file_hash text,
     source_page_start integer,
     source_page_end integer,
     notes text,
     extraction_raw jsonb,
     confidence text,
     credit_of_invoice_id integer,
     needs_review boolean NOT NULL DEFAULT false,
     reconciled boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS cost_packages (
     id serial PRIMARY KEY,
     project_id integer NOT NULL,
     code text,
     name text NOT NULL,
     original_budget numeric,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS invoice_line_items (
     id serial PRIMARY KEY,
     invoice_id integer NOT NULL,
     product_id integer,
     cost_package_id integer,
     description text NOT NULL,
     raw_description text,
     quantity numeric,
     unit text,
     raw_unit text,
     normalised_unit text,
     unit_price_ex_vat numeric,
     line_net numeric NOT NULL DEFAULT 0,
     line_vat numeric NOT NULL DEFAULT 0,
     line_gross numeric NOT NULL DEFAULT 0,
     vat_rate numeric,
     is_price_tracked boolean NOT NULL DEFAULT true,
     cost_type text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS price_records (
     id serial PRIMARY KEY,
     product_id integer NOT NULL,
     supplier_id integer NOT NULL,
     project_id integer,
     invoice_id integer,
     invoice_line_item_id integer,
     price_ex_vat numeric NOT NULL,
     vat_amount numeric,
     price_inc_vat numeric,
     vat_rate numeric,
     unit text,
     normalised_unit text,
     invoice_date date,
     invoice_number text,
     transaction_type text NOT NULL DEFAULT 'invoice',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS supplier_aliases (
     id serial PRIMARY KEY,
     supplier_id integer NOT NULL,
     normalised_name text NOT NULL,
     raw_name text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

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

  `CREATE TABLE IF NOT EXISTS variations (
     id serial PRIMARY KEY,
     project_id integer NOT NULL,
     title text NOT NULL,
     description text,
     amount numeric,
     status text NOT NULL DEFAULT 'proposed',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  // --- FUNCTIONAL unique indexes the application relies on --------------------

  // Duplicate-invoice guard. commitInvoice depends on this so a re-import can
  // never double-count spend/VAT. Partial: only when a document number exists.
  `CREATE UNIQUE INDEX IF NOT EXISTS invoices_supplier_type_number_uidx
     ON invoices (supplier_id, transaction_type, lower(btrim(invoice_number)))
     WHERE invoice_number IS NOT NULL AND btrim(invoice_number) <> ''`,

  // Supplier-alias learning ON CONFLICT (normalised_name) DO NOTHING.
  `CREATE UNIQUE INDEX IF NOT EXISTS supplier_aliases_norm_idx
     ON supplier_aliases (normalised_name)`,

  // Classification learning ON CONFLICT (key_kind, key_value, coalesce(supplier_id,0)).
  `CREATE UNIQUE INDEX IF NOT EXISTS classification_mappings_key_idx
     ON classification_mappings (key_kind, key_value, COALESCE(supplier_id, 0))`,
]

let applied = 0
for (const stmt of DDL) {
  await pool.query(stmt)
  applied++
}
console.log(`Base migration applied: ${applied} statements OK.`)

const tables = await pool.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)
console.log("base tables present:", tables.rows.map((r) => r.table_name).join(", "))

await pool.end()
