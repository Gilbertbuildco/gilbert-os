/**
 * Bradfords backlog, Aug-Sep 2026. Figures read VERBATIM off the rendered
 * invoices (Total Amount / Total VAT / Invoice Total); every one was checked to
 * add up before being written. Nothing inferred.
 *
 * All dated on or after 1 Aug 2026, so all UNPAID under the owner's rule
 * (see memory: bradfords-payment-rule). The invoice carries the VAT; the Amex
 * payment that eventually settles it must not (vat-double-claim-trap).
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const ROWS: [string, string, number, number, number][] = [
  ["78568125", "2026-08-24", 132.10, 26.42, 158.52],
  ["78575574", "2026-08-13", 381.84, 76.37, 458.21],
  ["78599986", "2026-09-01", 55.53, 11.11, 66.64],
  ["78606082", "2026-09-02", 88.56, 17.71, 106.27],
  ["78624152", "2026-09-07", 11.46, 2.29, 13.75],
  ["78628885", "2026-09-08", 321.60, 64.32, 385.92],
  ["78637805", "2026-09-07", 4347.76, 869.55, 5217.31],
  ["78650276", "2026-09-14", 2398.76, 479.75, 2878.51],
  ["78656291", "2026-09-15", 109.80, 21.96, 131.76],
  ["78669940", "2026-09-17", 354.00, 70.80, 424.80],
  ["78688605", "2026-09-22", 189.88, 37.98, 227.86],
  ["78690973", "2026-09-23", 114.40, 22.88, 137.28],
  ["78698102", "2026-09-24", 34.80, 6.96, 41.76],
]
for (const [n, , net, vat, gross] of ROWS)
  if (Math.abs(net + vat - gross) > 0.005) { console.log(`REFUSING: ${n} does not add up`); process.exit(1) }
console.log(`all ${ROWS.length} totals reconcile\n`)

const s = await pool.query(`select id from suppliers where lower(name) like '%bradford%' limit 1`)
const supplierId = s.rows[0].id
const p = await pool.query(`select id from projects order by id limit 1`)
const projectId = p.rows[0].id

let add = 0, skip = 0
for (const [num, date, net, vat, gross] of ROWS) {
  const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`, [supplierId, num])
  if (ex.rows.length) { skip++; console.log(`  skip ${num} (already present)`); continue }
  add++
  if (!EXECUTE) { console.log(`  would add ${num}  ${date}  ${gross.toFixed(2)}`); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, needs_review, confidence, source_file_name)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,'unpaid',false,1,$9) on conflict do nothing`,
    [supplierId, projectId, num, date, net, vat, gross,
     "Transcribed verbatim from the emailed PDF, account 206/GIL157. Dated on or after 1 Aug 2026 so unpaid under the owner's Bradfords rule.",
     `Invoice No. ${num}.PDF`])
  console.log(`  added ${num}  ${date}  ${gross.toFixed(2)}`)
}
console.log(`\n${EXECUTE ? "added" : "would add"} ${add}, already present ${skip}`)
console.log(`backlog value: ${ROWS.reduce((a, r) => a + r[4], 0).toFixed(2)} gross, VAT ${ROWS.reduce((a, r) => a + r[3], 0).toFixed(2)}`)
if (EXECUTE) {
  const d = await pool.query(`select invoice_number, count(*) n from invoices where supplier_id=$1 group by 1 having count(*)>1`, [supplierId])
  console.log(`duplicate check: ${d.rows.length === 0 ? "clean" : JSON.stringify(d.rows)}`)
}
process.exit(0)
