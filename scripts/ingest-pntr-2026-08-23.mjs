/**
 * PNTR SW Ltd painting invoices 1141, 1148 and 1155.
 *
 * HUGO SAUNDERS IS PNTR SW LTD. Invoice 1141 is headed "Hugo Saunders PNTR SW
 * LTD" with PNTR's bank details, so the £1,298.00 "Painting 1.0" already in the
 * OS under a "Hugo Saunders" supplier is this same invoice. The two supplier
 * records are merged rather than left to double-count the trade.
 *
 * That also resolves a gap flagged earlier: Xero shows £3,440.39 paid to Hugo
 * Saunders against £1,298.00 on file. £464.39 + £2,976.00 = £3,440.39 exactly —
 * invoices 1148 and 1155, both paid, neither ingested.
 *
 * All three are ZERO-RATED (0.0% Z on every line — new build), so net = gross
 * and no VAT is recorded. Values transcribed verbatim from the PDFs.
 *
 * NOT PUSHED TO XERO AS BILLS. The money already sits there as coded SPEND
 * transactions; adding bills would count the same cost twice (non-negotiable
 * #8). The push script's ALREADY_PAID_AS_SPEND guard would refuse them anyway.
 *
 * Idempotent. Dry-run by default.
 */
import { readFileSync } from "node:fs"
import pg from "pg"
for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")
const f = (n) => `£${Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const INV = [
  { n: "1148", d: "2026-06-16", net: 464.39, lines: [["Paint for plot 3 (put on Crown account)", 464.39]] },
  { n: "1155", d: "2026-07-03", net: 2976.00, lines: [
      ["Spraying Plot 2 — stage payment 1 of 5", 1012.00],
      ["Spraying Plot 3 — payment 1 of 3", 1166.00],
      ["Paint for Plot 3", 638.00],
      ["Masking materials for spraying Plots 1, 2 and 3", 160.00]] },
]
const NOTE = "PNTR SW Ltd, zero-rated (new build). Paid — matches the Xero bank payment to the 'Hugo Saunders' contact, which is the same business. Not pushed to Xero as a bill: the cost is already recorded there as coded spend."

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const { rows: [pntr] } = await c.query(`SELECT id, name FROM suppliers WHERE name ILIKE '%pntr%' LIMIT 1`)
  const { rows: [hugo] } = await c.query(`SELECT id, name FROM suppliers WHERE name ILIKE '%hugo saunders%' LIMIT 1`)
  const { rows: [pkg] } = await c.query(`SELECT id, name FROM cost_packages WHERE project_id=1 AND code='15'`)

  if (hugo) {
    const mv = await c.query(`UPDATE invoices SET supplier_id=$1 WHERE supplier_id=$2`, [pntr.id, hugo.id])
    await c.query(`UPDATE quotes SET supplier_id=$1 WHERE supplier_id=$2`, [pntr.id, hugo.id])
    await c.query(`INSERT INTO supplier_aliases (supplier_id, normalised_name) VALUES ($1,'hugosaunders') ON CONFLICT DO NOTHING`, [pntr.id])
    await c.query(`DELETE FROM supplier_aliases WHERE supplier_id=$1`, [hugo.id])
    await c.query(`DELETE FROM suppliers WHERE id=$1`, [hugo.id])
    console.log(`  merged "${hugo.name}" into "${pntr.name}" — ${mv.rowCount} invoice(s) moved, alias kept`)
    // The existing £1,298 row IS invoice 1141: give it its real number.
    const r = await c.query(
      `UPDATE invoices SET invoice_number='1141',
         notes=COALESCE(NULLIF(notes,'')||' | ','')||'Identified as PNTR SW Ltd invoice 1141 (Plot 1 spraying, stage payment 1 of 5). Was recorded under a separate "Hugo Saunders" supplier.'
       WHERE supplier_id=$1 AND invoice_number='Painting 1.0' RETURNING id`, [pntr.id])
    if (r.rowCount) console.log(`  existing £1,298.00 row renumbered to invoice 1141`)
  }

  let n = 0
  for (const inv of INV) {
    if ((await c.query(`SELECT 1 FROM invoices WHERE supplier_id=$1 AND invoice_number=$2`, [pntr.id, inv.n])).rowCount) {
      console.log(`  = ${inv.n} already present`); continue
    }
    const sum = inv.lines.reduce((s, [, v]) => s + v, 0)
    if (Math.round(sum * 100) !== Math.round(inv.net * 100)) throw new Error(`${inv.n}: lines ${sum} != total ${inv.net}`)
    if (!EXECUTE) { console.log(`  + ${inv.n} ${inv.d} ${f(inv.net)} (${inv.lines.length} lines)`); n++; continue }
    const { rows: [row] } = await c.query(
      `INSERT INTO invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
         net, vat, gross, status, payment_status, paid_date, amount_paid, notes, payment_notes, source_file_name)
       VALUES ($1,1,$2,$3::date,'invoice',$4,0,$4,'confirmed','paid',$3::date,$4,$5,$5,$6) RETURNING id`,
      [pntr.id, inv.n, inv.d, inv.net, NOTE, `PNTR-${inv.n}.pdf`])
    for (const [desc, v] of inv.lines)
      await c.query(`INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price_ex_vat, line_net, cost_package_id, is_price_tracked)
                     VALUES ($1,$2,1,$3,$3,$4,false)`, [row.id, desc, v, pkg.id])
    console.log(`  + ${inv.n} ${f(inv.net)} -> #${row.id}`)
    n++
  }
  const { rows: [t] } = await c.query(`SELECT count(*)::int n, COALESCE(SUM(net),0) t FROM invoices WHERE supplier_id=$1 AND status='confirmed'`, [pntr.id])
  console.log(`\n  ${pntr.name}: ${t.n} invoices, ${f(t.t)} invoiced against the ${f(17380)} estimate`)
  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("  DRY RUN.") }
  else { await c.query("COMMIT"); console.log("  COMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("  rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
