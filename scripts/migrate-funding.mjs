/**
 * Idempotent Phase 2A migration — funding budget foundation.
 * Safe to run repeatedly. Never drops or alters existing invoice/commercial
 * data; only adds new tables/columns.
 */
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const DDL = [
  `CREATE TABLE IF NOT EXISTS funding_budgets (
     id serial PRIMARY KEY,
     project_id integer NOT NULL,
     name text NOT NULL,
     lender text,
     status text NOT NULL DEFAULT 'original_locked',
     is_original boolean NOT NULL DEFAULT true,
     works_total numeric,
     professional_fees_total numeric,
     original_total numeric,
     amount_to_borrow numeric,
     reconciled boolean NOT NULL DEFAULT false,
     notes text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS funding_budget_lines (
     id serial PRIMARY KEY,
     funding_budget_id integer NOT NULL,
     section text NOT NULL DEFAULT 'works',
     description text NOT NULL,
     original_amount numeric NOT NULL DEFAULT 0,
     cost_package_code text,
     forecast_to_complete numeric,
     notes text,
     position integer NOT NULL DEFAULT 0,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS funding_line_package_map (
     id serial PRIMARY KEY,
     funding_budget_line_id integer NOT NULL,
     cost_package_id integer NOT NULL,
     weight numeric,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS funding_drawdowns (
     id serial PRIMARY KEY,
     funding_budget_line_id integer NOT NULL,
     work_complete_pct numeric,
     funding_earned numeric,
     funding_certified numeric,
     funding_drawn numeric,
     notes text,
     updated_at timestamptz NOT NULL DEFAULT now(),
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  // Cost Type dimension on existing actual-cost lines. Nullable, no backfill of
  // fabricated values — NULL means "not yet classified".
  `ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS cost_type text`,

  // Helpful indexes / integrity guards.
  `CREATE INDEX IF NOT EXISTS idx_funding_budgets_project ON funding_budgets(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_funding_lines_budget ON funding_budget_lines(funding_budget_id)`,
  `CREATE INDEX IF NOT EXISTS idx_funding_map_line ON funding_line_package_map(funding_budget_line_id)`,
  `CREATE INDEX IF NOT EXISTS idx_funding_map_pkg ON funding_line_package_map(cost_package_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_funding_map_pair ON funding_line_package_map(funding_budget_line_id, cost_package_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_funding_drawdown_line ON funding_drawdowns(funding_budget_line_id)`,
  // At most one ORIGINAL (locked baseline) funding budget per project.
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_original_budget_per_project
     ON funding_budgets(project_id) WHERE is_original = true`,
]

let applied = 0
for (const stmt of DDL) {
  await pool.query(stmt)
  applied++
}
console.log(`Funding migration applied: ${applied} statements OK.`)

// Verify shape.
const cols = await pool.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'invoice_line_items' AND column_name = 'cost_type'`)
console.log("invoice_line_items.cost_type present:", cols.rows.length === 1)

const tables = await pool.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_name LIKE 'funding_%' ORDER BY table_name`)
console.log("funding tables:", tables.rows.map((r) => r.table_name).join(", "))

await pool.end()
