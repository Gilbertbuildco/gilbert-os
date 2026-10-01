/**
 * Howdens kitchen, bought on Amex, settled by three bank payments:
 *   05/08  THOMAS L GILBERT      553.10   (Amex reimbursement)
 *   05/08  THOMAS L GILBERT    9,147.00   (Amex reimbursement)
 *   02/09  AMERICAN EXPRESS   14,558.25   (card bill)
 *   total                     24,258.35   owner-confirmed as the kitchen price incl VAT
 *
 * NO INVOICE DOCUMENT IS HELD. Every Howdens attachment in the mail store is a
 * K8 estimate or a plan - there is no VAT invoice. The 4,043.06 cannot properly
 * be reclaimed without one, so this is flagged needs_review and the note says so.
 *
 * Howdens Joinery is NOT Howden Insurance (supplier 8) - different companies that
 * a substring match has already conflated once.
 */
import { pool } from "../lib/db"
const EXECUTE=process.argv.includes("--execute")
const GROSS=24258.35
const NET=Math.round((GROSS/1.2)*100)/100
const VAT=Math.round((GROSS-NET)*100)/100
console.log(`gross ${GROSS.toFixed(2)}  net ${NET.toFixed(2)}  VAT ${VAT.toFixed(2)}  (check ${(NET+VAT).toFixed(2)})`)
if(Math.abs(NET+VAT-GROSS)>0.02){ console.log("REFUSING: does not add up"); process.exit(1) }
if(!EXECUTE){ console.log("(dry run)"); process.exit(0) }
let s=await pool.query(`select id,name from suppliers where lower(name) like '%howdens%'`)
if(!s.rows.length){
  s=await pool.query(`insert into suppliers (name,contact,notes) values ($1,$2,$3) returning id,name`,
    ["Howdens Joinery","Sherborne@howdens.com",
     "Kitchens, HJ Sherborne store. NOT Howden Insurance (supplier 8) - different company, and a substring match has conflated the two before."])
  console.log(`created supplier ${s.rows[0].name}`)
}
const p=await pool.query(`select id from projects order by id limit 1`)
const ex=await pool.query(`select id from invoices where supplier_id=$1 and invoice_number='HOWDENS-KITCHEN-2026-08'`,[s.rows[0].id])
if(ex.rows.length){ console.log("already present"); process.exit(0) }
await pool.query(
  `insert into invoices (supplier_id,project_id,invoice_number,invoice_date,transaction_type,
     net,vat,gross,status,notes,payment_status,paid_date,amount_paid,payment_notes,needs_review,confidence)
   values ($1,$2,'HOWDENS-KITCHEN-2026-08','2026-08-05','invoice',$3,$4,$5,'confirmed',$6,'paid','2026-09-02',$5,$7,true,1)`,
  [s.rows[0].id,p.rows[0].id,NET,VAT,GROSS,
   "Howdens kitchen bought on Amex. Owner-confirmed 2026-10-01 that 24,258.35 is the total price including VAT; net and VAT derived at 20%. NO VAT INVOICE HELD - every Howdens document in the mail store is a K8 estimate or a plan. The 4,043.06 of input VAT needs the actual invoice from Howdens before it can properly be reclaimed. Reference is date-derived; replace with the real invoice number when it arrives.",
   "Owner-confirmed 2026-10-01: settled by three bank payments - 553.10 and 9,147.00 to Thomas L Gilbert on 05/08 reimbursing the Amex, and 14,558.25 to American Express on 02/09. All three sit unreconciled in Xero."])
console.log(`added Howdens kitchen  ${GROSS.toFixed(2)}  VAT ${VAT.toFixed(2)}  marked paid`)
process.exit(0)
