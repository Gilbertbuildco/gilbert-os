/**
 * READ-ONLY handover introspection. Creates NO data. Dumps schema shape, row
 * counts, Higher Farm metadata, the Goldentree schedule verbatim, mapping
 * status per line, and current recognised spend for the handover pack.
 */
import { Pool } from "pg"
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const out = {}

// 1) Tables + columns
const cols = await pool.query(`
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema='public'
  ORDER BY table_name, ordinal_position`)
out.columns = cols.rows

// 2) Indexes / constraints
const idx = await pool.query(`
  SELECT tablename, indexname, indexdef FROM pg_indexes
  WHERE schemaname='public' ORDER BY tablename, indexname`)
out.indexes = idx.rows

// 3) Row counts for every public table
const tbls = await pool.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)
out.counts = {}
for (const t of tbls.rows) {
  const c = await pool.query(`SELECT count(*)::int n FROM "${t.table_name}"`)
  out.counts[t.table_name] = c.rows[0].n
}

// 4) Projects (metadata)
out.projects = (await pool.query(`SELECT * FROM projects ORDER BY id`)).rows

// 5) Higher Farm cost packages
out.hfPackages = (await pool.query(
  `SELECT id, code, name, original_budget FROM cost_packages WHERE project_id=1 ORDER BY code`)).rows

// 6) Funding budget header
out.fundingBudget = (await pool.query(`SELECT * FROM funding_budgets WHERE project_id=1`)).rows

// 7) Goldentree lines verbatim + mapping status
out.fundingLines = (await pool.query(`
  SELECT l.id, l.position, l.section, l.description, l.original_amount,
    (SELECT string_agg(p.code, ',' ORDER BY p.code)
       FROM funding_line_package_map m JOIN cost_packages p ON p.id=m.cost_package_id
       WHERE m.funding_budget_line_id=l.id) AS mapped_codes,
    (l.notes IS NOT NULL) AS has_note, l.notes
  FROM funding_budget_lines l WHERE l.funding_budget_id=1
  ORDER BY l.section DESC, l.position`)).rows

// 8) Recognised spend (matches lib/funding/queries.ts filter: confirmed + classified)
out.spend = (await pool.query(`
  SELECT
    (SELECT count(*)::int FROM invoices WHERE status='confirmed') AS confirmed_invoices,
    (SELECT count(*)::int FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id WHERE i.status='confirmed') AS confirmed_lines,
    (SELECT count(*)::int FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id WHERE i.status='confirmed' AND li.cost_package_id IS NOT NULL) AS classified_lines,
    (SELECT coalesce(sum(li.line_net),0)::numeric FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id WHERE i.status='confirmed') AS total_net,
    (SELECT coalesce(sum(li.line_net),0)::numeric FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id WHERE i.status='confirmed' AND li.cost_package_id IS NOT NULL) AS classified_net
  `)).rows[0]

// 9) Spend by cost package (Higher Farm)
out.spendByPackage = (await pool.query(`
  SELECT p.code, p.name, coalesce(sum(li.line_net),0)::numeric net, count(li.id)::int lines
  FROM invoice_line_items li
  JOIN invoices i ON i.id=li.invoice_id
  JOIN cost_packages p ON p.id=li.cost_package_id
  WHERE i.status='confirmed'
  GROUP BY p.code, p.name ORDER BY net DESC`)).rows

console.log(JSON.stringify(out, (k, v) => (typeof v === "bigint" ? Number(v) : v), 1))
await pool.end()
