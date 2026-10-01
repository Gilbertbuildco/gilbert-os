/**
 * Re-assert the 30 Sep Amex batch as paid, this time with a note the sync
 * recognises. lib/reconciliation/match-spend.ts protects any row whose
 * payment_notes mentions "owner"; my first note said "Settled 30 Sep 2026 on
 * Amex..." with no such word, so the 1 Oct run pulled all twenty back to unpaid
 * from Xero's bill status. 170 other rows were protected correctly - the
 * mechanism works, the wording did not.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const BATCH=["78483398","78481976","78494276","78508226","78513175","78518272","78575574","78565469",
 "78530306","78537916","78537307","78536853","78536200","78547422","78554269","78568125","78566952",
 "78566797","78565522","78596849"]
const NOTE="Owner-confirmed 2026-09-30: settled on Amex, the bank payment going to Tom Gilbert to clear the card. Xero holds no payment against the bill because the money left as an Amex reimbursement, so this status is owner-asserted and must not be downgraded from Xero. VAT is reclaimed on the invoice; the reimbursement must carry none."
const s=await pool.query(`select id from suppliers where lower(name) like '%bradford%' limit 1`)
const before=await pool.query(
  `select count(*) n from invoices where supplier_id=$1 and invoice_number=any($2) and payment_status='paid'`,[s.rows[0].id,BATCH])
console.log(`currently paid: ${before.rows[0].n} of ${BATCH.length}`)
if(!EXECUTE){ console.log("(dry run)"); process.exit(0) }
const u=await pool.query(
  `update invoices set payment_status='paid', paid_date='2026-09-30', amount_paid=gross,
     payment_notes = case when coalesce(payment_notes,'') ilike '%owner-confirmed 2026-09-30%'
                          then payment_notes else coalesce(payment_notes||' | ','')||$3 end
   where supplier_id=$1 and invoice_number=any($2) and transaction_type='invoice'
   returning invoice_number, gross`,[s.rows[0].id,BATCH,NOTE])
console.log(`re-asserted ${u.rowCount} paid, ${u.rows.reduce((a:number,x:any)=>a+Number(x.gross),0).toFixed(2)}`)
const after=await pool.query(
  `select count(*) n from invoices where supplier_id=$1 and invoice_number=any($2)
     and payment_status='paid' and coalesce(payment_notes,'') ilike '%owner%'`,[s.rows[0].id,BATCH])
console.log(`now protected from the sync: ${after.rows[0].n} of ${BATCH.length}`)
const owed=await pool.query(
  `select count(*) n, sum(case when transaction_type='credit' then gross else gross-coalesce(amount_paid,0) end)::numeric g
     from invoices where supplier_id=$1 and coalesce(payment_status,'unpaid')<>'paid'`,[s.rows[0].id])
console.log(`Bradfords still owed: ${owed.rows[0].n} items, ${Number(owed.rows[0].g??0).toFixed(2)}`)
process.exit(0)
