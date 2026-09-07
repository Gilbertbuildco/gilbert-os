import { xeroGet } from "../lib/xero/client"
const parse = (v: any) => { const m = /\/Date\((\d+)/.exec(String(v ?? "")); return m ? new Date(Number(m[1])).toISOString().slice(0,10) : String(v ?? "").slice(0,10) }
const s = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="1746"`, { headers: { Accept: "application/json" } })
const stub = ((await s.json()).Invoices ?? [])[0]
const g = await xeroGet(`/api.xro/2.0/Invoices/${stub.InvoiceID}`, { headers: { Accept: "application/json" } })
const i = ((await g.json()).Invoices ?? [])[0]
console.log(`BILL 1746  ${parse(i.Date)}  ${i.Status}  total ${i.Total}  VAT ${i.TotalTax}  paid ${i.AmountPaid}  due ${i.AmountDue}`)
for (const l of i.LineItems ?? []) console.log(`  line: acct ${l.AccountCode}  ${l.TaxType}  net ${l.LineAmount}  vat ${l.TaxAmount}  "${l.Description}"`)
console.log("\nPAYMENTS APPLIED:")
for (const p of i.Payments ?? []) console.log(`  ${parse(p.Date)}  ${p.Amount}  ${p.PaymentID}`)
if (!(i.Payments ?? []).length) console.log("  (none - so 'PAID' came from a credit note or manual settlement)")
for (const c of i.CreditNotes ?? []) console.log(`  CREDIT NOTE applied: ${c.CreditNoteNumber} ${c.AppliedAmount}`)

console.log("\nHISTORY:")
const h = await xeroGet(`/api.xro/2.0/Invoices/${stub.InvoiceID}/History`, { headers: { Accept: "application/json" } })
if (h.ok) for (const r of ((await h.json()).HistoryRecords ?? [])) console.log(`  ${parse(r.DateUTC)}  ${r.Changes ?? ""}  ${r.User ?? ""}  ${(r.Details ?? "").slice(0,80)}`)
else console.log("  history unavailable", h.status)

console.log("\nCLOSE BROTHERS (vehicle finance) records:")
const r2 = await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000", { headers: { Accept: "application/json" } })
for (const t of ((await r2.json()).BankTransactions ?? [])) {
  if (!/close brothers/i.test(t.Contact?.Name ?? "")) continue
  console.log(`  ${parse(t.Date)}  ${t.Type}  total ${String(t.Total).padStart(8)}  VAT ${String(t.TotalTax).padStart(7)}`)
}
process.exit(0)
