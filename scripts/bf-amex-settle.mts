/**
 * The 20 Bradfords invoices settled on 30 Sep 2026, paid on Amex. The bank
 * payment goes to TOM GILBERT to clear the Amex card, not to Bradfords.
 *
 * VAT RULE (memory: vat-double-claim-trap): the INVOICE carries the VAT, the
 * Amex reimbursement carries NONE. The bills in Xero are where the input tax is
 * reclaimed. When the payment to Tom Gilbert reaches the bank feed it must be
 * MATCHED against these bills, never coded to Building Materials — coding it
 * would reclaim the same VAT a second time, which is exactly what happened with
 * the earlier Bradfords Amex payments.
 *
 * NOTE WORDING IS LOAD-BEARING: lib/reconciliation/match-spend.ts protects a
 * row from being downgraded only if payment_notes mentions "owner". The first
 * version of this note did not, so the 1 Oct daily run pulled all twenty back
 * to unpaid from Xero's bill status. Any owner-asserted payment status must say
 * "Owner-confirmed".
 *
 * Five of the twenty are not held and have no document anywhere on disk. Their
 * gross comes from the Bradfords account statement; net and VAT are derived at
 * 20%, which every Bradfords invoice read so far uses throughout. Flagged
 * needs_review so the document gets attached.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const PAID_DATE = "2026-09-30"
const NOTE = "Owner-confirmed 2026-09-30: settled on Amex; the bank payment goes to Tom Gilbert to clear the card. VAT is reclaimed on this invoice — the Amex reimbursement must carry none."
const HELD = ["78483398","78481976","78494276","78508226","78513175","78518272","78575574",
              "78530306","78537916","78537307","78536853","78536200","78547422","78554269","78568125"]
const NEW: [string,string,number][] = [
  ["78565469","2026-08-14",288.01],["78566952","2026-08-24",112.85],["78566797","2026-08-24",255.72],
  ["78565522","2026-08-24",683.62],["78596849","2026-08-28",6190.02],
]
const s = await pool.query(`select id from suppliers where lower(name) like '%bradford%' limit 1`)
const sid = s.rows[0].id
const p = await pool.query(`select id from projects order by id limit 1`)

console.log("--- insert the five not held ---")
for (const [num, date, gross] of NEW) {
  const net = Math.round((gross / 1.2) * 100) / 100
  const vat = Math.round((gross - net) * 100) / 100
  const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`, [sid, num])
  if (ex.rows.length) { console.log(`  skip ${num}`); continue }
  console.log(`  ${num}  ${date}  net ${net.toFixed(2).padStart(9)}  VAT ${vat.toFixed(2).padStart(8)}  gross ${gross.toFixed(2).padStart(9)}`)
  if (!EXECUTE) continue
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, paid_date, amount_paid, payment_notes, needs_review, confidence)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,'paid',$9,$7,$10,true,1) on conflict do nothing`,
    [sid, p.rows[0].id, num, date, net, vat, gross,
     "Gross taken from the Bradfords account statement; net and VAT derived at 20%. NO DOCUMENT HELD — pull the PDF from the Bradfords site and attach it.",
     PAID_DATE, NOTE])
}
console.log("\n--- mark the fifteen held as paid ---")
if (EXECUTE) {
  const u = await pool.query(
    `update invoices set payment_status='paid', paid_date=$3, amount_paid=gross,
       payment_notes = coalesce(payment_notes || ' | ','') || $4
     where supplier_id=$1 and invoice_number = any($2) and transaction_type='invoice'
     returning invoice_number, gross`, [sid, HELD, PAID_DATE, NOTE])
  console.log(`  marked ${u.rowCount} paid, ${u.rows.reduce((a:number,x:any)=>a+Number(x.gross),0).toFixed(2)}`)
} else console.log(`  would mark ${HELD.length}`)

const t = await pool.query(
  `select count(*) n, sum(gross)::numeric g from invoices where supplier_id=$1 and paid_date=$2`, [sid, PAID_DATE])
console.log(`\nsettled on ${PAID_DATE}: ${t.rows[0].n} invoices, ${Number(t.rows[0].g ?? 0).toFixed(2)}`)
const owed = await pool.query(
  `select count(*) n, sum(case when transaction_type='credit' then gross else gross-coalesce(amount_paid,0) end)::numeric g
     from invoices where supplier_id=$1 and coalesce(payment_status,'unpaid')<>'paid'`, [sid])
console.log(`Bradfords still owed: ${owed.rows[0].n} items, ${Number(owed.rows[0].g ?? 0).toFixed(2)}`)
process.exit(0)
