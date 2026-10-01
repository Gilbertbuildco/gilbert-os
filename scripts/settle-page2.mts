/**
 * From page 2 of the Xero reconcile queue, which I had not opened.
 *   29 Sep  MAYFLOWER KBB   12,797.49   -> clears invoice 685 (7,157.67 outstanding) and more
 *   30 Sep  RHYS HARVEY      4,870.00   -> INV-0563 exactly
 *   30 Sep  CARRARINO        1,506.00   -> INV-1579 exactly
 *   30 Sep  ROSEAL LTD         327.50   -> invoice 3302 exactly
 * All sit unreconciled, so Xero shows the bills unpaid and the API cannot see
 * the payments. Owner-confirmed so the daily sync cannot downgrade them.
 */
import { pool } from "../lib/db"
const EXECUTE=process.argv.includes("--execute")
const ROWS:[string,string,string,string][]=[
 ["mayflow","685","2026-09-29","Owner-confirmed 2026-10-01: Mayflower payment 12,797.49 on 29 Sep 2026 clears the 7,157.67 balance on this invoice (deposit 7,158.50 paid in Aug). Payment is unreconciled in Xero."],
 ["rhys","INV-0563","2026-09-30","Owner-confirmed 2026-10-01: Rhys Harvey payment 4,870.00 on 30 Sep 2026 matches this invoice exactly. Payment is unreconciled in Xero."],
 ["carrarino","INV-1579","2026-09-30","Owner-confirmed 2026-10-01: Carrarino payment 1,506.00 on 30 Sep 2026 matches this invoice exactly. Payment is unreconciled in Xero."],
 ["roseal","3302","2026-09-30","Owner-confirmed 2026-10-01: Roseal payment 327.50 on 30 Sep 2026 matches this invoice exactly. Payment is unreconciled in Xero."],
]
for(const [sup,num,date,note] of ROWS){
  const s=await pool.query(`select id,name from suppliers where lower(name) like '%'||$1||'%'`,[sup])
  if(s.rows.length!==1){ console.log(`  ${num}: supplier match ${s.rows.length}`); continue }
  const i=await pool.query(`select id,gross,payment_status from invoices where supplier_id=$1 and invoice_number=$2`,[s.rows[0].id,num])
  if(!i.rows.length){ console.log(`  ${num}: not in the OS`); continue }
  if(!EXECUTE){ console.log(`  would mark ${s.rows[0].name} ${num} paid ${date} (${Number(i.rows[0].gross).toFixed(2)})`); continue }
  await pool.query(
    `update invoices set payment_status='paid', paid_date=$2, amount_paid=gross,
       payment_notes=coalesce(payment_notes||' | ','')||$3 where id=$1`,[i.rows[0].id,date,note])
  console.log(`  ${String(s.rows[0].name).slice(0,20).padEnd(21)} ${num.padEnd(10)} -> paid  ${Number(i.rows[0].gross).toFixed(2).padStart(10)}`)
}
const t=await pool.query(
  `select sum(gross-coalesce(amount_paid,0))::numeric g, count(*) n from invoices
    where transaction_type='invoice' and coalesce(payment_status,'unpaid')<>'paid'`)
console.log(`\nOS owed now: ${t.rows[0].n} invoices, ${Number(t.rows[0].g).toFixed(2)}`)
const by=await pool.query(
  `select s.name, count(*) n, sum(i.gross-coalesce(i.amount_paid,0))::numeric g
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.transaction_type='invoice' and coalesce(i.payment_status,'unpaid')<>'paid'
    group by 1 having sum(i.gross-coalesce(i.amount_paid,0))>0 order by 3 desc limit 8`)
for(const x of by.rows) console.log(`  ${String(x.name).slice(0,26).padEnd(27)} ${String(x.n).padStart(3)}  ${Number(x.g).toFixed(2).padStart(11)}`)
process.exit(0)
