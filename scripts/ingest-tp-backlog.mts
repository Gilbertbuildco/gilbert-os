/**
 * Travis Perkins backlog, Aug-Sep 2026. Figures transcribed VERBATIM from the
 * PDF text layer (GOODS AMOUNT / VAT TOTAL / INVOICE TOTAL); nothing derived.
 *
 * OS ONLY. These must NOT be pushed to Xero as bills without first reconciling
 * against the coded TP SPEND payments already there - £3,157.44 of TP input VAT
 * is claimed on those payments, and adding bills alongside them double-claims
 * it exactly as the Bradfords ones did. See memory: vat-double-claim-trap.
 */
import { readFileSync } from "node:fs"
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const rows: { num: string; date: string; net: number; vat: number; gross: number }[] =
  JSON.parse(readFileSync("/tmp/tp-rows.json", "utf8"))

const s = await pool.query(`select id, name from suppliers where lower(name) like '%travis%'`)
if (s.rows.length !== 1) { console.log("supplier lookup ambiguous:", s.rows); process.exit(1) }
const supplierId = s.rows[0].id
const p = await pool.query(`select id from projects order by id limit 1`)
const projectId = p.rows[0].id
console.log(`supplier ${supplierId} (${s.rows[0].name})  project ${projectId}`)

let toAdd = 0, skip = 0
for (const r of rows) {
  const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`, [supplierId, r.num])
  if (ex.rows.length) { skip++; continue }
  toAdd++
  const iso = r.date.split("/").reverse().join("-")
  if (!EXECUTE) { console.log(`  would add ${r.num}  ${iso}  net ${r.net.toFixed(2)} vat ${r.vat.toFixed(2)} gross ${r.gross.toFixed(2)}`); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, needs_review, confidence, source_file_name)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,'unpaid',false,1,$9)
     on conflict do nothing`,
    [supplierId, projectId, r.num, iso, r.net, r.vat, r.gross,
     "Transcribed verbatim from the emailed PDF. Account CQ5893, order ref HIGHER FARM. NOT pushed to Xero: TP payments there are coded SPEND carrying input VAT already.",
     `${r.num}_1.pdf`])
  console.log(`  added ${r.num}  ${iso}  ${r.gross.toFixed(2)}`)
}
console.log(`\n${EXECUTE ? "added" : "would add"} ${toAdd}, already present ${skip}`)
if (EXECUTE) {
  const d = await pool.query(
    `select invoice_number, count(*) n from invoices where supplier_id=$1 group by 1 having count(*)>1`, [supplierId])
  console.log(`duplicate check for this supplier: ${d.rows.length === 0 ? "clean" : JSON.stringify(d.rows)}`)
  const t = await pool.query(`select count(*) n, sum(gross)::numeric g from invoices where supplier_id=$1`, [supplierId])
  console.log(`Travis Perkins in the OS: ${t.rows[0].n} invoices, ${Number(t.rows[0].g).toFixed(2)}`)
}
process.exit(0)
