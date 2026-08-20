/**
 * Idempotent migration: `reconciliation_runs` table — one row per run of the
 * daily Xero-half reconciliation job (payment sync -> bill push -> read-only
 * three-way report), whether triggered by the Vercel cron
 * (`app/api/cron/reconcile`) or a manual CLI run.
 *
 * Safe to run repeatedly: every statement is `CREATE TABLE IF NOT EXISTS` /
 * `ADD COLUMN IF NOT EXISTS`. Additive only — touches no existing table.
 *
 * As with every other table in this schema, there is no DB-level foreign key
 * here; this table stands alone (no references out).
 *
 * USAGE
 *   node --env-file=.env.development.local scripts/add-reconciliation-runs.mjs
 */
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const DDL = [
  `CREATE TABLE IF NOT EXISTS reconciliation_runs (
     id serial PRIMARY KEY,
     ran_at timestamptz NOT NULL DEFAULT now(),
     ok boolean NOT NULL,
     payments_synced integer,
     bills_created integer,
     payments_missing_invoice integer,
     missing_total numeric,
     summary jsonb,
     error text
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_ran_at ON reconciliation_runs(ran_at DESC)`,
]

let applied = 0
for (const stmt of DDL) {
  await pool.query(stmt)
  applied++
}
console.log(`reconciliation_runs migration applied: ${applied} statements OK.`)

const cols = await pool.query(`
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_schema='public' AND table_name='reconciliation_runs' ORDER BY ordinal_position`)
console.log("reconciliation_runs columns:", cols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(", "))

await pool.end()
