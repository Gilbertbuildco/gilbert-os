import { pool } from "../lib/db"
import { xeroGet } from "../lib/xero/client"
const parse = (v: any) => { const m=/\/Date\((\d+)/.exec(String(v??"")); return m? new Date(Number(m[1])).toISOString().slice(0,10):String(v??"").slice(0,10) }
const r = await pool.query(
  `select s.name, i.invoice_number, to_char(i.invoice_date,'YYYY-MM-DD') d, i.net, i.vat, i.gross, i.payment_status
     from invoices i join suppliers s on s.id=i.supplier_id
    where lower(s.name) like '%jr%carpen%' or lower(s.name) like '%jordan%' or lower(s.name) like '%reeves%'
    order by i.invoice_date`)
console.log("OS records:")
for (const x of r.rows) console.log(`  ${String(x.name).slice(0,20).padEnd(21)} ${String(x.invoice_number).padEnd(8)} ${x.d}  net ${x.net}  vat ${x.vat}  gross ${x.gross}  ${x.payment_status}`)
if (!r.rows.length) console.log("  (none)")

console.log("\nXero, JR Carpentry / Jordan Reeves:")
for (const path of ['/api.xro/2.0/Invoices?where=Type=="ACCPAY"&pageSize=100', "/api.xro/2.0/BankTransactions?pageSize=1000"]) {
  const g = await xeroGet(path, { headers: { Accept: "application/json" } })
  const j = await g.json()
  for (const t of (j.Invoices ?? j.BankTransactions ?? [])) {
    if (!/jr carpen|jordan|reeves/i.test(t.Contact?.Name ?? "")) continue
    console.log(`  ${t.Type ?? "BILL"}  ${parse(t.Date)}  ${t.Contact?.Name}  ${t.InvoiceNumber ?? t.Reference ?? ""}  total ${t.Total}  VAT ${t.TotalTax}  ${t.Status}`)
  }
}
process.exit(0)
