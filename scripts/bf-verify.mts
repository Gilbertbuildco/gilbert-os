import { xeroGet } from "../lib/xero/client"
let removed = 0
for (const num of ["77983446", "77983461"]) {
  const s = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${num}"`, { headers: { Accept: "application/json" } })
  const stub = ((await s.json()).Invoices ?? [])[0]
  const g = await xeroGet(`/api.xro/2.0/Invoices/${stub.InvoiceID}`, { headers: { Accept: "application/json" } })
  const i = ((await g.json()).Invoices ?? [])[0]
  const was = num === "77983446" ? 3233.40 : 8511.80
  removed += was - i.TotalTax
  console.log(`${num}  total ${i.Total.toFixed(2)}  VAT ${was.toFixed(2)} -> ${i.TotalTax.toFixed(2)}  status ${i.Status}`)
  for (const l of i.LineItems ?? []) console.log(`    ${String(l.LineAmount).padStart(10)}  ${String(l.TaxType).padEnd(7)} vat ${String(l.TaxAmount).padStart(8)}  ${(l.Description ?? "").slice(0, 52)}`)
}
console.log(`\nVAT removed from the reclaim so far: ${removed.toFixed(2)}`)
console.log(`July return: 40542.63 -> ${(40542.63 - removed).toFixed(2)}`)
console.log(`still to do: the 4 July Amex payments, 5016.51 (needs Remove & Redo - reconciled)`)
process.exit(0)
