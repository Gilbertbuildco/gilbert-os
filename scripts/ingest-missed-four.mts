/** The four suppliers missed by subject-pattern matching. Figures verbatim. */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
type R = { supMatch: string; supNew?: [string,string,string]; num: string; date: string;
           net: number; vat: number; gross: number; paid: boolean; note: string }
const ROWS: R[] = [
  { supMatch: "harlequin", num: "09", date: "2026-09-07", net: 7008.50, vat: 0, gross: 7008.50, paid: false,
    note: "Plot 2 draw 4,108.00 + plot 3 draw 2,781.00 + plot 1 garage base 87.50 + cement collection 32.00. Invoice states VAT = N/A." },
  { supMatch: "harlequin", num: "10", date: "2026-09-21", net: 8395.00, vat: 0, gross: 8395.00, paid: false,
    note: "Plot 2 draw 1,000.00 + plot 3 draw 6,400.00 + E/O water table plot 2 775.00 + works to garages 220.00. Invoice states VAT = N/A." },
  { supMatch: "r smith", supNew: ["R. Smith and Sons","01749 812510","Agricultural contractors, Pitcombe. VAT reg 336 6492 36."],
    num: "42/26", date: "2026-09-23", net: 6452.50, vat: 1290.50, gross: 7743.00, paid: false,
    note: "Hire of JCB & operator breaking and crushing concrete, 17 Aug - 7 Sep, 115.5 hours @ 55.00/hr." },
  { supMatch: "mayflower kbb", supNew: ["Mayflower KBB","Lois@mayflowerkitchens.co.uk","Kitchens. Account Gi1740. VAT reg 728 7342 13."],
    num: "664", date: "2026-09-25", net: 8053.40, vat: 1610.68, gross: 9664.08, paid: false,
    note: "Supply of Belgravia inframe painted shell kitchen door furniture, plot 1. Our ref 7727-REV03." },
  { supMatch: "screwfix", supNew: ["Screwfix","online@screwfix.com","Trade counter. Customer no. 29780163733. Paid in store at point of sale."],
    num: "A27923895342", date: "2026-09-09", net: 15.82, vat: 3.17, gross: 18.99, paid: true,
    note: "Stormguard weatherstrip. Paid in store." },
  { supMatch: "screwfix", num: "A28184440914", date: "2026-09-22", net: 35.86, vat: 7.18, gross: 43.04, paid: true,
    note: "Wall anchors, TurboGold screws, concrete screws. Paid in store." },
  { supMatch: "screwfix", num: "A28232424017", date: "2026-09-24", net: 49.98, vat: 10.00, gross: 59.98, paid: true,
    note: "Forge Steel trestles x2. Paid in store." },
]
for (const r of ROWS)
  if (Math.abs(r.net + r.vat - r.gross) > 0.005) { console.log(`REFUSING ${r.num}`); process.exit(1) }
const p = await pool.query(`select id from projects order by id limit 1`)
let add = 0
for (const r of ROWS) {
  let s = await pool.query(`select id, name from suppliers where lower(name) like '%'||$1||'%'`, [r.supMatch])
  if (!s.rows.length && r.supNew) {
    if (EXECUTE) {
      const ins = await pool.query(`insert into suppliers (name, contact, notes) values ($1,$2,$3) returning id, name`, r.supNew)
      s = ins; console.log(`  created supplier ${r.supNew[0]}`)
    } else { console.log(`  would create supplier ${r.supNew[0]}`); }
  }
  if (!s.rows.length) { console.log(`  ${r.num}: no supplier yet (dry run) - skipping`); continue }
  if (s.rows.length > 1) { console.log(`  ${r.num}: ambiguous supplier`, s.rows.map((x:any)=>x.name)); continue }
  const supplierId = s.rows[0].id
  const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`, [supplierId, r.num])
  if (ex.rows.length) { console.log(`  skip ${r.num} (present)`); continue }
  add++
  if (!EXECUTE) { console.log(`  would add ${s.rows[0].name} ${r.num} ${r.date} ${r.gross.toFixed(2)}`); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, paid_date, needs_review, confidence)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,$9,$10,false,1) on conflict do nothing`,
    [supplierId, p.rows[0].id, r.num, r.date, r.net, r.vat, r.gross, r.note,
     r.paid ? "paid" : "unpaid", r.paid ? r.date : null])
  console.log(`  added ${String(s.rows[0].name).slice(0,20).padEnd(21)} ${r.num.padEnd(14)} ${r.date}  ${r.gross.toFixed(2).padStart(9)}  ${r.paid ? "paid" : "unpaid"}`)
}
console.log(`\n${EXECUTE ? "added" : "would add"} ${add}`)
process.exit(0)
