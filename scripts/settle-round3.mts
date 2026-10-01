/**
 * Three more settlements, with the evidence behind each stated honestly.
 *   Scope 5030        4,447.20  payment sits in the reconcile queue, 10 Aug, ref 5030
 *   Crestmoor 1511+1536         reconciled SPEND of 2,677.20 on 24 Jun = 1,257.60 + 1,419.60 exactly
 *   Mark Hodges x3    3,350.00  OWNER'S WORD ONLY - no payment to him exists anywhere in Xero,
 *                               not as a transaction and not in the reconcile queue.
 */
import { pool } from "../lib/db"
const EXECUTE=process.argv.includes("--execute")
const JOBS:[string,string[],string,string][]=[
 ["scope",["5030"],"2026-08-10","Owner-confirmed 2026-10-01: paid. Xero reconcile queue holds a Scope payment of 4,447.20 dated 10 Aug 2026 with reference 5030, and Xero itself suggests the match. Unreconciled, so no payment shows against the bill."],
 ["crestmoor",["INV-1511","INV-1536"],"2026-06-24","Owner-confirmed 2026-10-01: paid. Reconciled Xero SPEND of 2,677.20 on 24 Jun 2026 equals INV-1511 (1,257.60) + INV-1536 (1,419.60) exactly."],
 ["hodges",["MH-2026-08-21","MH-2026-08-28","MH-2026-09-16"],"2026-09-30","Owner-confirmed 2026-10-01: paid in full per the owner. NOTE no payment to Mark Hodges exists anywhere in Xero - not as a bank transaction and not in the reconcile queue - so this status rests on the owner's word, not on payment evidence. Likely settled outside the business account."],
]
for(const [sup,nums,date,note] of JOBS){
  const s=await pool.query(`select id,name from suppliers where lower(name) like '%'||$1||'%'`,[sup])
  if(s.rows.length!==1){ console.log(`  ${sup}: matched ${s.rows.length} suppliers`); continue }
  if(!EXECUTE){ console.log(`  would mark ${s.rows[0].name}: ${nums.join(", ")}`); continue }
  const u=await pool.query(
    `update invoices set payment_status='paid', paid_date=$3, amount_paid=gross,
       payment_notes=coalesce(payment_notes||' | ','')||$4
     where supplier_id=$1 and invoice_number=any($2) and transaction_type='invoice'
     returning invoice_number, gross`,[s.rows[0].id,nums,date,note])
  console.log(`  ${String(s.rows[0].name).slice(0,24).padEnd(25)} ${u.rowCount} paid, ${u.rows.reduce((a:number,x:any)=>a+Number(x.gross),0).toFixed(2)}`)
}
const t=await pool.query(
  `select count(*) n, sum(gross-coalesce(amount_paid,0))::numeric g from invoices
    where transaction_type='invoice' and coalesce(payment_status,'unpaid')<>'paid'`)
console.log(`\nOS owed now: ${t.rows[0].n} invoices, ${Number(t.rows[0].g).toFixed(2)}`)
const by=await pool.query(
  `select s.name, count(*) n, sum(i.gross-coalesce(i.amount_paid,0))::numeric g
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.transaction_type='invoice' and coalesce(i.payment_status,'unpaid')<>'paid'
    group by 1 having sum(i.gross-coalesce(i.amount_paid,0))>0 order by 3 desc`)
for(const x of by.rows) console.log(`  ${String(x.name).slice(0,28).padEnd(29)} ${String(x.n).padStart(3)}  ${Number(x.g).toFixed(2).padStart(11)}`)
process.exit(0)
