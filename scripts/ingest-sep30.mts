/**
 * New invoices from the 30 Sep sweep. Figures verbatim.
 * Crestmoor INV-1654 is deliberately EXCLUDED: Nicole Hannam at Crestmoor
 * emailed 30/09 "I've accidentally duplicated your invoice... please disregard
 * the second invoice. INV-1639 is the correct invoice to pay."
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
type R = { sup: string; newSup?: [string,string,string]; num: string; date: string; net: number; vat: number; gross: number; note: string }
const ROWS: R[] = [
  { sup: "carrarino", newSup: ["Carrarino Limited","Paolo@carrarino.co.uk","Quartz/stone worktops, Axminster. VAT 194631096."],
    num: "INV-1579", date: "2026-09-30", net: 1255.00, vat: 251.00, gross: 1506.00,
    note: "Plot 1 deposit — supply and install worktop in 20mm Quartz Alaska White from Classic Quartz & Stone; polished cut-outs for undermounted sinks, tap hole, drainage grooves." },
  { sup: "bradford", num: "78706882", date: "2026-09-26", net: 87.55, vat: 17.51, gross: 105.06,
    note: "Account 206/GIL157, order 29167572." },
  { sup: "bradford", num: "78710153", date: "2026-09-28", net: 1675.19, vat: 335.04, gross: 2010.23,
    note: "Account 206/GIL157, order 29164305, delivered to Higher Farm." },
  { sup: "mayflower kbb", num: "685", date: "2026-09-30", net: 11930.14, vat: 2386.03, gross: 14316.17,
    note: "Plot 3 Belgravia shell — inframe Belgravia painted shell kitchen door furniture and Aldana Stone utility kitchen door furniture. Our ref 7693-REV03." },
  { sup: "travis", num: "1052242465", date: "2026-09-29", net: 6.85, vat: 1.37, gross: 8.22,
    note: "Account CQ5893. OS only — not pushed to Xero, TP payments there are coded SPEND already carrying the input VAT." },
]
for (const r of ROWS) if (Math.abs(r.net + r.vat - r.gross) > 0.02) { console.log(`REFUSING ${r.num}`); process.exit(1) }
const p = await pool.query(`select id from projects order by id limit 1`)
let add = 0
for (const r of ROWS) {
  let s = await pool.query(`select id, name from suppliers where lower(name) like '%'||$1||'%'`, [r.sup])
  if (!s.rows.length && r.newSup) {
    if (!EXECUTE) { console.log(`  would create supplier ${r.newSup[0]}`); continue }
    s = await pool.query(`insert into suppliers (name, contact, notes) values ($1,$2,$3) returning id, name`, r.newSup)
    console.log(`  created supplier ${r.newSup[0]}`)
  }
  if (s.rows.length !== 1) { console.log(`  ${r.num}: supplier match ${s.rows.length}`, s.rows.map((x:any)=>x.name)); continue }
  const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`, [s.rows[0].id, r.num])
  if (ex.rows.length) { console.log(`  skip ${r.num} (present)`); continue }
  add++
  if (!EXECUTE) { console.log(`  would add ${r.num} ${r.gross.toFixed(2)}`); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, needs_review, confidence)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,'unpaid',false,1) on conflict do nothing`,
    [s.rows[0].id, p.rows[0].id, r.num, r.date, r.net, r.vat, r.gross, r.note])
  console.log(`  added ${String(s.rows[0].name).slice(0,20).padEnd(21)} ${r.num.padEnd(13)} ${r.date}  ${r.gross.toFixed(2).padStart(10)}`)
}
console.log(`\n${EXECUTE?"added":"would add"} ${add}`)
console.log("EXCLUDED: Crestmoor INV-1654 (4,316.88) — supplier confirmed it is a duplicate of INV-1639")
process.exit(0)
