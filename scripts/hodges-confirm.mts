import { pool } from "../lib/db"
import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const s = await pool.query(`select id from suppliers where lower(name) like '%hodges%'`)
const id = s.rows[0].id
const u = await pool.query(
  `update invoices set needs_review = false,
     notes = replace(notes, ' No VAT stated - confirm whether he is VAT registered.',
                     ' Owner confirmed 2026-09-26: Mark Hodges does not charge VAT.')
   where supplier_id = $1 returning invoice_number, gross, vat, needs_review`, [id])
console.log(`cleared review flag on ${u.rowCount}:`)
for (const x of u.rows) console.log(`  ${x.invoice_number}  ${Number(x.gross).toFixed(2).padStart(8)}  vat ${x.vat}  needs_review ${x.needs_review}`)
await pool.query(`update suppliers set notes = $2 where id = $1`,
  [id, "Tiler. Invoices arrive as plain text in the email body, no attachment — the sweep needs the body scan to see them. Owner confirmed 2026-09-26: does not charge VAT, so any payment to him coded with VAT in Xero is an over-claim."])

console.log("\nXero payments to Mark Hodges:")
const g = await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000", { headers: { Accept: "application/json" } })
let any=false, tax=0
for (const t of ((await g.json()).BankTransactions ?? [])) {
  if (!/hodge/i.test(t.Contact?.Name ?? "")) continue
  any=true; tax += t.TotalTax ?? 0
  console.log(`  ${parse(t.Date)}  ${t.Type}  ${t.Total}  VAT ${t.TotalTax}  ${t.Status}${(t.TotalTax??0)>0?"   <-- CLAIMS VAT HE DID NOT CHARGE":""}`)
}
if (!any) console.log("  none — he has not been paid through the bank feed yet, so nothing to over-claim")
else if (tax===0) console.log("  all correctly at zero VAT")
process.exit(0)
