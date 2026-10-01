import { xeroGet, xeroFetch } from "../lib/xero/client"
const EXECUTE = process.argv.includes("--execute")
const cn = await xeroGet("/api.xro/2.0/CreditNotes", { headers: { Accept: "application/json" } })
const credits = ((await cn.json()).CreditNotes ?? []).filter((c:any)=>/5088485|5088486/.test(c.CreditNoteNumber??""))
for (const c of credits) {
  const g = await xeroGet(`/api.xro/2.0/CreditNotes/${c.CreditNoteID}`, { headers: { Accept: "application/json" } })
  const full = ((await g.json()).CreditNotes ?? [])[0]
  console.log(`${full.CreditNoteNumber}  remaining ${full.RemainingCredit}`)
  for (const a of full.Allocations ?? [])
    console.log(`   allocated ${a.Amount} to ${a.Invoice?.InvoiceNumber}  allocationID ${a.AllocationID ?? "(not returned)"}`)
}
if (!EXECUTE) { console.log("\n(inspect only — pass --execute to attempt the correction)"); process.exit(0) }
// 50884868 belongs against 77983461, not 77983446
const wrong = credits.find((c:any)=>c.CreditNoteNumber==="50884868")
const g = await xeroGet(`/api.xro/2.0/CreditNotes/${wrong.CreditNoteID}`, { headers: { Accept: "application/json" } })
const full = ((await g.json()).CreditNotes ?? [])[0]
const alloc = (full.Allocations ?? [])[0]
if (!alloc?.AllocationID) { console.log("\nNo AllocationID returned by this API version — the allocation cannot be deleted programmatically.") ; process.exit(0) }
const d = await xeroFetch(`/api.xro/2.0/CreditNotes/${wrong.CreditNoteID}/Allocations/${alloc.AllocationID}`, { method: "DELETE", headers: { Accept: "application/json" } })
console.log(`delete allocation -> ${d.status} ${(await d.text()).slice(0,160)}`)
process.exit(0)
