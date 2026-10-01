import { pool } from "../lib/db"
const r=await pool.query(
  `select invoice_number, payment_status, paid_date, amount_paid, left(payment_notes,150) notes
     from invoices where invoice_number in ('78518272','78596849','78565522')`)
for(const x of r.rows){
  console.log(`${x.invoice_number}  status=${x.payment_status}  paid_date=${x.paid_date??"null"}  amount_paid=${x.amount_paid??"null"}`)
  console.log(`   notes: ${x.notes??"(none)"}\n`)
}
process.exit(0)
