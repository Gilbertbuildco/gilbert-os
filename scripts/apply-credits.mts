/**
 * Allocate the two Bradfords credit notes against outstanding Bradfords bills.
 * Pure allocation: it touches no reconciled bank transaction, creates no
 * payment, and cannot double-count anything. It just stops 10,177.20 of credit
 * sitting unused while the same supplier shows as owed.
 */
import { xeroGet, xeroFetch } from "../lib/xero/client"
const EXECUTE = process.argv.includes("--execute")
const cn = await xeroGet("/api.xro/2.0/CreditNotes", { headers: { Accept: "application/json" } })
const credits = ((await cn.json()).CreditNotes ?? []).filter((c: any) => (c.RemainingCredit ?? 0) > 0)
const bills: any[] = []
for (let p = 1; ; p++) { const r = await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`, { headers: { Accept: "application/json" } })
  const inv = (await r.json()).Invoices ?? []; bills.push(...inv); if (inv.length < 100) break }
for (const c of credits) {
  let remaining = c.RemainingCredit ?? 0
  console.log(`\n${c.CreditNoteNumber}  ${c.Contact?.Name}  remaining ${remaining.toFixed(2)}`)
  const open = bills.filter(b => b.Status === "AUTHORISED" && (b.AmountDue ?? 0) > 0
      && String(b.Contact?.Name) === String(c.Contact?.Name))
    .sort((a, b) => (a.DateString ?? "").localeCompare(b.DateString ?? ""))   // oldest first
  for (const b of open) {
    if (remaining <= 0.005) break
    const amt = Math.min(remaining, b.AmountDue ?? 0)
    console.log(`   -> ${String(b.InvoiceNumber).padEnd(13)} ${(b.DateString ?? "").slice(0,10)}  due ${String(b.AmountDue).padStart(9)}   allocate ${amt.toFixed(2).padStart(9)}`)
    if (EXECUTE) {
      const r = await xeroFetch(`/api.xro/2.0/CreditNotes/${c.CreditNoteID}/Allocations`, { method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ Allocations: [{ Invoice: { InvoiceID: b.InvoiceID }, Amount: Number(amt.toFixed(2)), Date: "2026-09-30" }] }) })
      if (!r.ok) { console.log(`        !! ${r.status} ${(await r.text()).slice(0,180)}`); break }
    }
    remaining -= amt
  }
  console.log(`   remaining after: ${remaining.toFixed(2)}`)
}
process.exit(0)
