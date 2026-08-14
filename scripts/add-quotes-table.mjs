/**
 * Idempotent migration — creates the `quotes` table (supplier/tradesman quote
 * documents, distinct from `invoices`). Safe to run repeatedly: every
 * statement is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.
 * Matches the style and safety protocol of scripts/add-invoice-payment-fields.mjs
 * and scripts/migrate-funding.mjs (no drizzle-kit; hand-written raw SQL is the
 * only migration mechanism in this repo — see CLAUDE.md).
 *
 * WHAT `quotes` IS FOR
 * A quote/estimate a supplier or tradesman gave Gilbert Build Co for future or
 * comparative work — distinct from `invoices` (money actually billed) and from
 * `funding_budget_lines` (the lender's Goldentree schedule, which this table
 * never touches). This lets the app answer "what were we quoted vs what have
 * we actually spent" (lib/queries.ts::getQuotesVsActual), without conflating
 * quotes into the invoice/actual-spend pipeline.
 *
 * COLUMNS
 *   supplier_id           int, NULL. App-enforced FK to suppliers (no DB-level
 *                          FK anywhere in this schema — see CLAUDE.md). NULL
 *                          means the quote is from a company that isn't a
 *                          known Gilbert OS supplier yet — ingestion NEVER
 *                          creates a supplier record just because a quote
 *                          mentions one (non-negotiable #1: don't fabricate/
 *                          expand financial-adjacent records from ambiguous
 *                          input). `supplier_name_raw` preserves what the
 *                          document actually said either way.
 *   supplier_name_raw     text. Verbatim heading/letterhead text, kept even
 *                          when supplier_id resolves, as the audit reference.
 *   project_id            int. App-enforced FK to projects.
 *   reference              text. The supplier's own quote/estimate number as
 *                          printed (e.g. "158445", "7728-REV02", "FGG947/1").
 *                          Never invented when absent.
 *   quote_date            date, NULL. The date printed on the quote. NULL, not
 *                          guessed, when the document doesn't show one clearly.
 *   description            text. Short human summary of what was quoted.
 *   scope                  text, NULL. Free text like "plot 1", "plots 1-3",
 *                          "kitchens" — whatever the document itself scopes
 *                          the quote to. NULL when the document doesn't say.
 *   net / vat / gross      numeric, NULL each. Read verbatim from the document.
 *                          A quote that only prints one of these (e.g. a net
 *                          total with VAT excluded but not quantified) leaves
 *                          the others NULL rather than a computed guess.
 *   status                  text, NULL. App-enforced 'accepted' | 'superseded'
 *                          | 'open'. NULL = not yet classified. No DB CHECK
 *                          constraint, matching every other status-like column
 *                          in this schema (invoices.status, funding_budgets.
 *                          status, etc.) — see CLAUDE.md "no DB-level FK/CHECK,
 *                          enforced in application code" convention.
 *   source_file_name / source_file_pathname / source_file_hash
 *                          Same retention pattern as invoices: original file
 *                          kept in Vercel Blob before/regardless of parsing,
 *                          SHA-256 for a secondary duplicate signal.
 *   notes                  text, NULL. Free text — e.g. why a status was
 *                          assigned, cross-references to a related document,
 *                          an unresolved ambiguity flagged for the owner.
 *
 * NO UNIQUE INDEX ON PURPOSE. Unlike invoices_supplier_type_number_uidx,
 * quotes deliberately has no DB-level uniqueness constraint: the same
 * supplier can legitimately issue several quotes sharing a reference-ish
 * number (alternate spec options, revisions, per-plot variants), and the
 * ingestion script's own duplicate guard (supplier_name_raw + reference +
 * gross) is a judgement the app makes, not a hard identity Postgres should
 * reject on. Two plain indexes are added for read performance only.
 */
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const DDL = [
  `CREATE TABLE IF NOT EXISTS quotes (
    id serial PRIMARY KEY,
    supplier_id integer,
    supplier_name_raw text,
    project_id integer,
    reference text,
    quote_date date,
    description text,
    scope text,
    net numeric,
    vat numeric,
    gross numeric,
    status text,
    source_file_name text,
    source_file_pathname text,
    source_file_hash text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_quotes_project ON quotes (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quotes_supplier ON quotes (supplier_id)`,
]

async function tableInfo() {
  const cols = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'quotes'
     ORDER BY ordinal_position`,
  )
  const idx = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'quotes' ORDER BY indexname`,
  )
  return { columns: cols.rows, indexes: idx.rows }
}

async function main() {
  console.log("--- BEFORE ---")
  console.log(JSON.stringify(await tableInfo(), null, 2))

  let applied = 0
  for (const stmt of DDL) {
    await pool.query(stmt)
    applied++
  }
  console.log(`\nMigration applied: ${applied} statements OK.`)

  console.log("\n--- AFTER ---")
  console.log(JSON.stringify(await tableInfo(), null, 2))

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
