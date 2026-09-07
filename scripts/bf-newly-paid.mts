import { pool } from "../lib/db"
import { xeroGet } from "../lib/xero/client"

const PAID: [string, string, number][] = [
  ["78322984", "2026-06-29", 209.71], ["78368056", "2026-07-08", 40.69],
  ["78384088", "2026-07-13", 430.20], ["78389147", "2026-07-14", 4317.76],
  ["78395807", "2026-07-15", 79.93],  ["78395354", "2026-07-15", 700.37],
  ["78414666", "2026-07-20", 316.80], ["78430923", "2026-07-22", 6190.02],
  ["78425752", "2026-07-22", 31.92],  ["78425167", "2026-07-22", 222.12],
  ["78446737", "2026-07-27", 275.52], ["78456186", "2026-07-29", 1436.40],
  ["78469740", "2026-07-31", 196.60],
]
console.log(`${PAID.length} invoices, total ${PAID.reduce((s, p) => s + p[2], 0).toFixed(2)}\n`)

console.log("invoice     date        gross      OS status        Xero status   Xero VAT")
for (const [num, date, gross] of PAID) {
  const os = await pool.query(
    `select id, payment_status, paid_date, gross from invoices where supplier_id in (select id from suppliers where lower(name) like '%bradford%') and invoice_number = $1`, [num])
  const r = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${num}"`, { headers: { Accept: "application/json" } })
  const x = ((await r.json()).Invoices ?? [])[0]
  const osRow = os.rows[0]
  const osTxt = osRow ? `${String(osRow.payment_status ?? "null").padEnd(12)}${Number(osRow.gross).toFixed(2) === gross.toFixed(2) ? "" : " AMT?"}` : "NOT IN OS   "
  const xTxt = x ? `${String(x.Status).padEnd(12)}  ${String(x.TotalTax)}` : "NOT IN XERO"
  console.log(`${num}  ${date}  ${gross.toFixed(2).padStart(8)}   ${osTxt}  ${xTxt}`)
}
console.log("\n--- any Bradfords bank payments in Xero since 1 Aug? ---")
const b = await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000", { headers: { Accept: "application/json" } })
const parse = (v: any) => { const m = /\/Date\((\d+)/.exec(String(v ?? "")); return m ? new Date(Number(m[1])).toISOString().slice(0,10) : "" }
let any = false
for (const t of ((await b.json()).BankTransactions ?? [])) {
  if (!/bradford/i.test(t.Contact?.Name ?? "")) continue
  const d = parse(t.Date); if (d < "2026-08-01") continue
  any = true; console.log(`  ${d}  ${t.Type}  ${t.Total}  VAT ${t.TotalTax}`)
}
if (!any) console.log("  none yet - payments have not reached the bank feed")
process.exit(0)
