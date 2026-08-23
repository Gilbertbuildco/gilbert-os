/**
 * Professional fees: bring the owner's monthly £6,000 into build cost, and put
 * the remaining two months of both site-management fees on the Position page.
 *
 * OWNER DECISION 2026-08-23. The £6,000/month previously recorded as a dividend
 * is payment for running the site, has been funded from Goldentree drawdowns,
 * and is a build cost for project reporting. He will continue to document it as
 * a dividend for TAX. Those are different questions and only the first is the
 * OS's: management reporting should show what the build actually costs.
 *
 * The tax treatment is expressly NOT settled here — a dividend is a
 * distribution of post-tax profit, not a deductible cost, and the same money
 * being described two ways is for his accountant to bless. Every row written
 * below carries that note, so if the accountant rules otherwise this is one
 * flag to reverse rather than an untraceable adjustment.
 *
 * Idempotent. Dry-run by default.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")

// The eight £6,000 payments, verbatim from Xero's Tom Gilbert contact.
const DIVS = [
  ["2025-12-01", "Interim dividend – Tom Gilbert"], ["2025-12-30", "Jan div"],
  ["2026-01-29", "Feb div"], ["2026-03-02", "Mar div"], ["2026-03-30", "Apr div"],
  ["2026-05-01", "Mar div"], ["2026-05-29", "May div"], ["2026-06-30", "June div"],
]
const NOTE = "Owner decision 2026-08-23: payment for running the site, funded from Goldentree drawdowns, so recorded as BUILD COST (professional fees) for project reporting. The owner documents it as a DIVIDEND for tax. The tax treatment is his accountant's to confirm and is not settled by this record."

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const { rows: [proj] } = await c.query(`SELECT id FROM projects WHERE slug='higher-farm'`)
  const { rows: [pkg] } = await c.query(`SELECT id, name FROM cost_packages WHERE project_id=$1 AND code='27'`, [proj.id])
  let sup = (await c.query(`SELECT id, name FROM suppliers WHERE name='Tom Gilbert — site management' LIMIT 1`)).rows[0]
  if (!sup) {
    const r = await c.query(`INSERT INTO suppliers (name) VALUES ('Tom Gilbert — site management') RETURNING id, name`)
    sup = r.rows[0]
    console.log(`  created supplier "${sup.name}"`)
  }

  let n = 0
  for (const [date, ref] of DIVS) {
    // Full date, not year-month: December, March and May each carry TWO
    // payments, and a month-based number silently collided so three of the
    // eight were skipped.
    const num = `SM-TG-${date}`
    if ((await c.query(`SELECT 1 FROM invoices WHERE supplier_id=$1 AND invoice_number=$2`, [sup.id, num])).rowCount) {
      console.log(`  = ${num} already present`); continue
    }
    if (!EXECUTE) { console.log(`  + ${num} ${date} £6,000.00  (${ref})`); n++; continue }
    const { rows: [inv] } = await c.query(
      `INSERT INTO invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
         net, vat, gross, status, payment_status, paid_date, amount_paid, notes, payment_notes, source_file_name)
       VALUES ($1,$2,$3,$4::date,'invoice',6000,0,6000,'confirmed','paid',$4::date,6000,$5,$5,'Xero bank payment (no invoice document)')
       RETURNING id`, [sup.id, proj.id, num, date, NOTE])
    await c.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price_ex_vat, line_net, cost_package_id, is_price_tracked)
       VALUES ($1,$2,1,6000,6000,$3,false)`,
      [inv.id, `Site management fee — paid ${date} (Xero reference "${ref}")`, pkg.id])
    console.log(`  + ${num} £6,000.00 -> #${inv.id}`)
    n++
  }
  console.log(`\n  ${n} months, £${(n * 6000).toLocaleString("en-GB")} moved into ${pkg.name}`)

  // Two months of both fees still to pay: September and October.
  const FUTURE = [
    ["EST-PROF-TG", "Tom Gilbert — site management, Sep + Oct", 12000],
    ["EST-PROF-GW", "George Wilson — site management, Sep + Oct", 12000],
  ]
  for (const [ref, desc, net] of FUTURE) {
    if ((await c.query(`SELECT 1 FROM quotes WHERE reference=$1`, [ref])).rowCount) { console.log(`  = ${ref} already recorded`); continue }
    if (EXECUTE) await c.query(
      `INSERT INTO quotes (supplier_id, supplier_name_raw, project_id, reference, quote_date, description, net, vat, gross, status, notes)
       VALUES (NULL,$1,$2,$3,DATE '2026-08-23',$4,$5,0,$5,'estimate',$6)`,
      [desc.split(" — ")[0], proj.id, ref, desc, net,
       "Owner 2026-08-23: site runs to end of October, £6,000 per month each. Two months remaining."])
    console.log(`  + ${ref} £${net.toLocaleString("en-GB")}  ${desc}`)
  }

  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\n  DRY RUN.") }
  else { await c.query("COMMIT"); console.log("\n  COMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("  rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
