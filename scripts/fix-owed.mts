/**
 * Two corrections, both evidenced, both written with an owner-protected note so
 * the daily Xero sync cannot revert them again.
 *
 * 1. The twelve July Bradfords invoices. The owner's standing rule is that every
 *    Bradfords invoice dated before 1 Aug 2026 is paid. They were marked paid in
 *    September and reverted by the sync.
 * 2. Mayflower 664 and 685. Their own proformas P554 and P556 state "LESS
 *    DEPOSIT RECEIVED WITH THANKS" at 50%, so half of each is settled.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const JULY=["78368056","78384088","78389147","78395354","78395807","78414666",
            "78425167","78425752","78430923","78446737","78456186","78469740"]
const BF_NOTE="Owner-confirmed: every Bradfords invoice dated before 1 Aug 2026 is paid (standing rule). Paid on Amex, so Xero holds no payment against the bill - owner-asserted, do not downgrade from Xero."
const MF=[["664",4832.50],["685",7158.50]] as [string,number][]
const MF_NOTE="Owner-confirmed: 50% deposit received, stated on Mayflower's own proforma as 'LESS DEPOSIT RECEIVED WITH THANKS' (P554 for invoice 664, P556 for 685). Part paid - owner-asserted, do not downgrade from Xero."

const bs=await pool.query(`select id from suppliers where lower(name) like '%bradford%' limit 1`)
const ms=await pool.query(`select id from suppliers where lower(name) like '%mayflow%' limit 1`)
if(!EXECUTE){
  const a=await pool.query(`select invoice_number, gross, payment_status from invoices where supplier_id=$1 and invoice_number=any($2)`,[bs.rows[0].id,JULY])
  console.log(`would mark ${a.rows.length} July Bradfords paid, ${a.rows.reduce((s:number,x:any)=>s+Number(x.gross),0).toFixed(2)}`)
  for(const [n,amt] of MF) console.log(`would mark Mayflower ${n} part_paid at ${amt.toFixed(2)}`)
  process.exit(0)
}
const u1=await pool.query(
  `update invoices set payment_status='paid', paid_date='2026-08-01', amount_paid=gross,
     payment_notes = case when coalesce(payment_notes,'') ilike '%owner-confirmed: every bradfords%'
                          then payment_notes else coalesce(payment_notes||' | ','')||$3 end
   where supplier_id=$1 and invoice_number=any($2) and transaction_type='invoice'
   returning invoice_number, gross`,[bs.rows[0].id,JULY,BF_NOTE])
console.log(`July Bradfords marked paid: ${u1.rowCount}, ${u1.rows.reduce((a:number,x:any)=>a+Number(x.gross),0).toFixed(2)}`)
for(const [num,amt] of MF){
  const r=await pool.query(
    `update invoices set payment_status='part_paid', amount_paid=$3,
       payment_notes = case when coalesce(payment_notes,'') ilike '%owner-confirmed: 50% deposit%'
                            then payment_notes else coalesce(payment_notes||' | ','')||$4 end
     where supplier_id=$1 and invoice_number=$2 returning gross`,[ms.rows[0].id,num,amt,MF_NOTE])
  if(r.rowCount) console.log(`Mayflower ${num}: gross ${Number(r.rows[0].gross).toFixed(2)}, paid ${amt.toFixed(2)}, outstanding ${(Number(r.rows[0].gross)-amt).toFixed(2)}`)
}
const owed=await pool.query(
  `select s.name, count(*) n, sum(i.gross-coalesce(i.amount_paid,0))::numeric g
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.transaction_type='invoice' and coalesce(i.payment_status,'unpaid')<>'paid'
    group by 1 having sum(i.gross-coalesce(i.amount_paid,0))>0 order by 3 desc limit 10`)
console.log("\nOS now says owed:")
for(const x of owed.rows) console.log(`  ${String(x.name).slice(0,26).padEnd(27)} ${String(x.n).padStart(3)}  ${Number(x.g).toFixed(2).padStart(11)}`)
const t=await pool.query(
  `select sum(gross-coalesce(amount_paid,0))::numeric g from invoices
    where transaction_type='invoice' and coalesce(payment_status,'unpaid')<>'paid'`)
console.log(`  TOTAL ${Number(t.rows[0].g).toFixed(2)}`)
process.exit(0)
