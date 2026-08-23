/**
 * Ingest the fourteen City Plumbing invoices that exist on their trade account
 * but never reached Gilbert OS.
 *
 * SOURCE. Transcribed verbatim from City Plumbing's own account portal
 * (Balance and Invoices, account 136694), not from a PDF — their invoice PDFs
 * sit behind an auth token this system cannot present. The portal IS the
 * supplier's ledger, and its reliability was checked first: the four invoices
 * the OS already held from email (T871/T872/T873/T704) match the portal to the
 * penny. `source_file_name` records the origin so nobody mistakes these for
 * document-backed rows; the PDFs can be attached later.
 *
 * VAT. Portal amounts are VAT-inclusive at 20%, so net = gross / 1.2. Values
 * are rounded to the penny and the split is asserted before writing.
 *
 * PAYMENT. All fourteen are settled by the single £16,793.24 payment now booked
 * as Xero bill CP-JUN2026-CONSOL. They are marked paid with that stated, along
 * with the £108.00 difference between the invoices (£16,901.24) and the payment
 * — which remains unexplained and is NOT presented as a discount.
 *
 * Duplicate protection: pre-flight check, in-transaction re-check, and the
 * partial unique index as backstop. Dry-run default.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")

// number, issue date, gross (inc VAT), their order ref, cost package code
const INV = [
  ["4207AJS623", "2026-06-26", 1943.96, "PLOT ONE UFH",     "09"],
  ["4207AJS621", "2026-06-26", 1371.82, "PLOT 2 UNITS TAP", "14"],
  ["4207AJS622", "2026-06-26", 3240.00, "TOILET PANS",      "14"],
  ["4207AJS624", "2026-06-26", 1796.48, "PLOT 2 UFH",       "09"],
  ["4207AJS625", "2026-06-26", 1839.20, "PLOT 3 UFH",       "09"],
  ["4207AJS618", "2026-06-26",  805.66, "PLOT 2 SHOWER TR", "14"],
  ["4207AJS600", "2026-06-26",  564.72, "",                 null],
  ["4207AJS620", "2026-06-26", 1389.64, "PLOT 1 UNITS TAP", "14"],
  ["4207AJS603", "2026-06-26",  528.00, "",                 null],
  ["4207AJS619", "2026-06-26", 1363.24, "PLOT 3",           null],
  ["4207AJS478", "2026-06-22",  499.66, "PLOT 3 SHOWER TR", "14"],
  ["4207AJS477", "2026-06-22",  553.10, "PLOT 1 SHOWER TR", "14"],
  ["4207AJS239", "2026-06-11",  141.76, "",                 null],
  ["4207AJR373", "2026-05-11",  864.00, "",                 null],
]
const NOTE = "Transcribed from City Plumbing's account portal 2026-08-23 (their PDFs are behind an auth token). Settled by the single £16,793.24 payment booked as Xero bill CP-JUN2026-CONSOL. The fourteen invoices total £16,901.24; the £108.00 difference is unexplained and is not evidenced as a discount."

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const { rows: [sup] } = await c.query(`SELECT id, name FROM suppliers WHERE name ILIKE '%city plumb%' LIMIT 1`)
  const { rows: [proj] } = await c.query(`SELECT id FROM projects WHERE slug='higher-farm'`)
  const { rows: pkgs } = await c.query(`SELECT id, code FROM cost_packages WHERE project_id=$1`, [proj.id])
  const pkgBy = new Map(pkgs.map((p) => [p.code, p.id]))

  let n = 0, skipped = 0, gross = 0, net = 0
  for (const [num, date, g, ref, code] of INV) {
    const nt = Number((g / 1.2).toFixed(2))
    const vat = Number((g - nt).toFixed(2))
    if (Math.round(nt * 100) + Math.round(vat * 100) !== Math.round(g * 100)) throw new Error(`${num}: VAT split does not balance`)
    const dup = await c.query(
      `SELECT id FROM invoices WHERE supplier_id=$1 AND transaction_type='invoice' AND invoice_number=$2`, [sup.id, num])
    if (dup.rowCount) { console.log(`  = ${num} already present`); skipped++; continue }
    gross += g; net += nt; n++
    if (!EXECUTE) { console.log(`  + ${num} ${date} gross £${g.toFixed(2)} net £${nt.toFixed(2)} vat £${vat.toFixed(2)}  ${ref || "(no ref)"} -> pkg ${code ?? "unclassified"}`); continue }
    const { rows: [inv] } = await c.query(
      `INSERT INTO invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
         net, vat, gross, status, payment_status, paid_date, amount_paid, notes, payment_notes, source_file_name)
       VALUES ($1,$2,$3,$4::date,'invoice',$5,$6,$7,'confirmed','paid',DATE '2026-06-26',$7,$8,$9,$10) RETURNING id`,
      [sup.id, proj.id, num, date, nt, vat, g, NOTE, NOTE, "City Plumbing account portal (no PDF)"])
    await c.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price_ex_vat, line_net, cost_package_id, is_price_tracked)
       VALUES ($1,$2,1,$3,$3,$4,false)`,
      [inv.id, ref ? `${ref} — City Plumbing ${num}` : `City Plumbing ${num}`, nt, code ? pkgBy.get(code) : null])
    console.log(`  + ${num} £${g.toFixed(2)} -> #${inv.id}  ${ref || ""}`)
  }
  console.log(`\n  ${n} to insert, ${skipped} already present`)
  console.log(`  gross £${gross.toFixed(2)}  net £${net.toFixed(2)}`)
  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("  DRY RUN.") }
  else { await c.query("COMMIT"); console.log("  COMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("  rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
