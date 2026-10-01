import { xeroGet, xeroFetch } from "../lib/xero/client"
const cn = await xeroGet(`/api.xro/2.0/CreditNotes`, { headers: { Accept: "application/json" } })
const c = ((await cn.json()).CreditNotes ?? []).find((x:any)=>x.CreditNoteNumber==="50884868")
const inv = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="77983461"`, { headers: { Accept: "application/json" } })
const b = ((await inv.json()).Invoices ?? [])[0]
console.log(`credit ${c.CreditNoteNumber} remaining ${c.RemainingCredit}  ->  bill ${b.InvoiceNumber} due ${b.AmountDue}`)
const amt = Math.min(c.RemainingCredit ?? 0, b.AmountDue ?? 0)
const r = await xeroFetch(`/api.xro/2.0/CreditNotes/${c.CreditNoteID}/Allocations`, { method: "PUT",
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  body: JSON.stringify({ Allocations: [{ Invoice: { InvoiceID: b.InvoiceID }, Amount: Number(amt.toFixed(2)), Date: "2026-09-30" }] }) })
console.log(`allocate ${amt.toFixed(2)} -> ${r.status}`)
// verify
for (const num of ["50884851","50884868"]) {
  const g = await xeroGet(`/api.xro/2.0/CreditNotes`, { headers: { Accept: "application/json" } })
  const x = ((await g.json()).CreditNotes ?? []).find((y:any)=>y.CreditNoteNumber===num)
  const f = await xeroGet(`/api.xro/2.0/CreditNotes/${x.CreditNoteID}`, { headers: { Accept: "application/json" } })
  const full = ((await f.json()).CreditNotes ?? [])[0]
  console.log(`  ${num}  remaining ${full.RemainingCredit}  -> ${(full.Allocations??[]).map((a:any)=>`${a.Amount} to ${a.Invoice?.InvoiceNumber}`).join(", ")}`)
}
for (const num of ["77983446","77983461"]) {
  const g = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${num}"`, { headers: { Accept: "application/json" } })
  const x = ((await g.json()).Invoices ?? [])[0]
  console.log(`  bill ${num}  total ${x.Total}  due ${x.AmountDue}  ${x.Status}`)
}
process.exit(0)
