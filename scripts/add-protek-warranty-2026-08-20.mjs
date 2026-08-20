/**
 * The Protek structural warranty premium was paid DIRECTLY by Goldentree to
 * Protek Group Ltd and never passed through the company bank, so it never
 * reached the OS — the same blind spot that hid the Target Timber invoices.
 *
 * Figure taken from the lender's own loan opening statement:
 *   "05/11/2025  Protek Group Ltd (re Warranty)  16,554.00"
 *
 * NOTE a real discrepancy, flagged not resolved: the stage-certificate matrix
 * shows £16,544.00 drawn against "Third Party Home Warranty or PCC" (allowance
 * £16,544.67) — £10 less than the opening statement says was paid. The opening
 * statement records an actual payment, so it is used here, and the difference
 * is raised as a question rather than silently reconciled.
 *
 * No invoice document exists in our records. Idempotent; dry run by default.
 */
import pg from "pg"

const EXECUTE = process.argv.includes("--execute")
const AMOUNT = 16554.00
const PAID = "2025-11-05"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const { rows: [dupe] } = await c.query(
    "SELECT i.id FROM invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE s.name ILIKE '%protek%'")
  if (dupe) { console.log(`already recorded as invoice #${dupe.id}`); await c.query("ROLLBACK"); process.exit(0) }

  console.log(`would add Protek Group Ltd £${AMOUNT.toFixed(2)} (${PAID}) — warranty premium, lender-paid direct`)
  console.log("  package 25 Building Control & Warranty, payment_status paid, needs_review, question attached")
  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\nDRY RUN — nothing written."); process.exit(0) }

  const { rows: [sup] } = await c.query("INSERT INTO suppliers (name) VALUES ('Protek Group Ltd') RETURNING id")
  await c.query("INSERT INTO supplier_aliases (supplier_id, normalised_name, raw_name) VALUES ($1,'protek group','Protek Group Ltd')", [sup.id])
  const { rows: [pkg] } = await c.query("SELECT id FROM cost_packages WHERE project_id=1 AND code='25'")
  const { rows: [inv] } = await c.query(`
    INSERT INTO invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
                          net, vat, gross, status, notes, needs_review, reconciled, payment_status, payment_notes)
    VALUES ($1, 1, NULL, $2, 'invoice', $3, 0, $3, 'confirmed', $4, true, true, 'paid', $5) RETURNING id`,
    [sup.id, PAID, AMOUNT,
     "Structural warranty premium. Paid directly by Goldentree to Protek Group Ltd — never through the company bank. Figure from the lender's loan opening statement (05/11/2025). No invoice document held.",
     "Paid direct by Goldentree Development Finance, per loan opening statement 05/11/2025. Owner-surfaced 2026-08-20."])
  await c.query(`
    INSERT INTO invoice_line_items (invoice_id, description, quantity, unit, unit_price_ex_vat,
                                    line_net, line_vat, line_gross, vat_rate, cost_package_id, is_price_tracked)
    VALUES ($1, 'Structural warranty premium — 3 plots, Higher Farm', 1, NULL, $2, $2, 0, $2, 0, $3, false)`,
    [inv.id, AMOUNT, pkg?.id ?? null])
  await c.query("UPDATE invoices SET review_question = $2, review_question_at = now() WHERE id = $1",
    [inv.id, "Two lender documents disagree on the Protek warranty premium: the loan opening statement says £16,554.00 paid on 05/11/2025, the stage-certificate matrix shows £16,544.00 drawn (allowance £16,544.67) — a £10 gap. I have used £16,554.00 as that records an actual payment. Can Protek send the invoice so we can settle which is right?"])
  await c.query("COMMIT")
  console.log(`  created supplier #${sup.id}, invoice #${inv.id}`)
  const { rows: [t] } = await pool.query(`SELECT COALESCE(SUM(li.line_net),0) s FROM invoice_line_items li
    JOIN invoices i ON i.id=li.invoice_id JOIN cost_packages cp ON cp.id=li.cost_package_id
    WHERE i.status='confirmed' AND cp.code='25' AND cp.project_id=1`)
  console.log(`\nCOMMITTED. Building Control & Warranty now £${Number(t.s).toFixed(2)}`)
} catch (e) { await c.query("ROLLBACK"); console.error("Rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
