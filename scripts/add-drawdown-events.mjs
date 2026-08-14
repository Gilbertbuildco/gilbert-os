/**
 * Idempotent migration — Goldentree drawdown-event layer.
 *
 * Adds two new tables. NEVER touches `funding_budget_lines` (the lender
 * schedule is immutable — non-negotiable #2) and never drops/alters anything
 * existing. Safe to run repeatedly against production; every statement is
 * `CREATE ... IF NOT EXISTS`.
 *
 *   funding_drawdown_events      — one row per drawdown/payment COLUMN in the
 *                                   lender's master matrix (a "Val 3 (MIP)",
 *                                   a direct payment, etc).
 *   funding_drawdown_allocations — one row per (event, funding line) grid
 *                                   cell, i.e. the reconstructed matrix body.
 *
 * Run:
 *   node --env-file=.env.development.local scripts/add-drawdown-events.mjs
 */
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const DDL = [
  `CREATE TABLE IF NOT EXISTS funding_drawdown_events (
     id serial PRIMARY KEY,
     funding_budget_id integer NOT NULL,
     event_key text NOT NULL,
     label text NOT NULL,
     event_date date,
     certified_total numeric,
     cash_received numeric,
     received_date date,
     direct_payment boolean NOT NULL DEFAULT false,
     notes text,
     source_file_name text,
     source_file_pathname text,
     source_file_hash text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS funding_drawdown_allocations (
     id serial PRIMARY KEY,
     event_id integer NOT NULL,
     funding_budget_line_id integer NOT NULL,
     amount numeric NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  // Helpful indexes / integrity guards.
  `CREATE INDEX IF NOT EXISTS idx_drawdown_events_budget ON funding_drawdown_events(funding_budget_id)`,
  `CREATE INDEX IF NOT EXISTS idx_drawdown_allocations_event ON funding_drawdown_allocations(event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_drawdown_allocations_line ON funding_drawdown_allocations(funding_budget_line_id)`,
  // One event key per budget (e.g. only one 'val3_mip' row per budget) so a
  // re-run of the ingest script can safely upsert instead of duplicating.
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_drawdown_event_key ON funding_drawdown_events(funding_budget_id, event_key)`,
  // A funding line can only appear once per event — no double-counting a cell.
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_drawdown_allocation_pair ON funding_drawdown_allocations(event_id, funding_budget_line_id)`,
]

let applied = 0
for (const stmt of DDL) {
  await pool.query(stmt)
  applied++
}
console.log(`Drawdown-events migration applied: ${applied} statements OK.`)

// Verify shape.
const tables = await pool.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_name IN ('funding_drawdown_events', 'funding_drawdown_allocations')
  ORDER BY table_name`)
console.log("tables present:", tables.rows.map((r) => r.table_name).join(", "))

const idx = await pool.query(`
  SELECT indexname FROM pg_indexes
  WHERE schemaname = 'public' AND tablename IN ('funding_drawdown_events', 'funding_drawdown_allocations')
  ORDER BY indexname`)
console.log("indexes present:", idx.rows.map((r) => r.indexname).join(", "))

await pool.end()
