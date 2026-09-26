import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const i = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="78322984"`, { headers: { Accept: "application/json" } })
for (const x of ((await i.json()).Invoices ?? []))
  console.log(`INVOICE   ${x.InvoiceNumber}  ${parse(x.Date)}  total ${x.Total}  VAT ${x.TotalTax}  ${x.Status}`)
const c = await xeroGet("/api.xro/2.0/CreditNotes", { headers: { Accept: "application/json" } })
for (const x of ((await c.json()).CreditNotes ?? []))
  if (/5088485|5088486/.test(x.CreditNoteNumber ?? ""))
    console.log(`CREDIT    ${x.CreditNoteNumber}  ${parse(x.Date)}  total ${x.Total}  VAT ${x.TotalTax}  ${x.Status}  remaining ${x.RemainingCredit}`)
console.log("\nnet effect on the next VAT return from these three:")
console.log("  +34.95 (late claim, never claimed before)")
console.log("  -646.68 -1049.52 (credit notes)")
console.log("  = -1661.25, plus the -180.00 Jordan Reeves recode = -1841.25")
process.exit(0)
