import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const BATCH=["78483398","78481976","78494276","78508226","78513175","78518272","78575574","78565469",
 "78530306","78537916","78537307","78536853","78536200","78547422","78554269","78568125","78566952",
 "78566797","78565522","78596849"]
console.log("the 20 you paid on 30 Sep — OS vs Xero\n")
let xeroOpen=0, n=0
for(const num of BATCH){
  const o=await pool.query(`select payment_status, gross from invoices where invoice_number=$1 and transaction_type='invoice'`,[num])
  const g=await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${num}"`,{headers:{Accept:"application/json"}})
  const b=((await g.json()).Invoices??[])[0]
  const os=o.rows[0]?.payment_status??"not in OS"
  if(b?.Status==="AUTHORISED"){ xeroOpen+=b.AmountDue??0; n++ }
  console.log(`  ${num}  OS=${String(os).padEnd(7)}  Xero=${b?`${String(b.Status).padEnd(10)} due ${String(b.AmountDue).padStart(9)}`:"NOT IN XERO"}`)
}
console.log(`\n  ${n} of these still AUTHORISED in Xero, ${xeroOpen.toFixed(2)} — all paid in the OS`)
console.log(`  this is the gap: Xero has no payment linked, so they sit as owed forever`)
process.exit(0)
