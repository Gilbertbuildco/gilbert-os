/**
 * The OS invoices that genuinely have no Xero bill AND no matching payment.
 * Every one was checked against Xero SPEND first: R. Smith has zero payments,
 * Mayflower's only payment is July's 2,000 deposit (not invoice 664), Mark
 * Hodges has none at all. Nothing here can double-count.
 *
 * Mark Hodges charges no VAT (owner confirmed) so those go in at NONE.
 */
import { xeroGet, xeroFetch } from "../lib/xero/client"
const EXECUTE = process.argv.includes("--execute")

const acc = await xeroGet("/api.xro/2.0/Accounts", { headers: { Accept: "application/json" } })
const codes = new Set(((await acc.json()).Accounts ?? []).map((a: any) => a.Code))
const pick = (want: string, fallback: string) => codes.has(want) ? want : fallback
const ACC_TILE = pick("1012", "4000"), ACC_PLANT = pick("5005", "4000"), ACC_KIT = pick("1112", "4000")
console.log(`accounts: tiling=${ACC_TILE} plant=${ACC_PLANT} kitchens=${ACC_KIT}`)

const DOCS = [
  { contact: "Mark Hodges", num: "MH-2026-08-21", date: "2026-08-21", net: 605.00,  tax: "NONE",   acct: ACC_TILE,  desc: "Tiling materials — floor matting, wall and floor adhesive" },
  { contact: "Mark Hodges", num: "MH-2026-08-28", date: "2026-08-28", net: 1050.00, tax: "NONE",   acct: ACC_TILE,  desc: "Tiling 30 m2 wall and floor at 35/m2" },
  { contact: "Mark Hodges", num: "MH-2026-09-16", date: "2026-09-16", net: 1695.00, tax: "NONE",   acct: ACC_TILE,  desc: "Tiling 37 m2 at 35/m2 plus floor and wall adhesive" },
  { contact: "R. Smith and Sons", num: "42/26", date: "2026-09-23", net: 6452.50, tax: "INPUT2", acct: ACC_PLANT, desc: "Hire of JCB & operator breaking and crushing concrete, 115.5 hrs @ 55.00" },
  { contact: "Mayflower Kitchens", num: "664", date: "2026-09-25", net: 8053.40, tax: "INPUT2", acct: ACC_KIT,   desc: "Supply of Belgravia inframe painted shell kitchen door furniture, plot 1" },
]
async function contactId(name: string) {
  const g = await xeroGet(`/api.xro/2.0/Contacts?where=Name=="${name}"`, { headers: { Accept: "application/json" } })
  const c = ((await g.json()).Contacts ?? [])[0]
  if (c) return c.ContactID
  if (!EXECUTE) { console.log(`  would create contact ${name}`); return null }
  const r = await xeroFetch("/api.xro/2.0/Contacts", { method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ Contacts: [{ Name: name }] }) })
  if (!r.ok) { console.log(`  !! contact ${name}: ${(await r.text()).slice(0,160)}`); return null }
  const id = ((await r.json()).Contacts ?? [])[0]?.ContactID
  console.log(`  created contact ${name}`)
  return id
}
const cache: Record<string,string|null> = {}
for (const d of DOCS) {
  const ex = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${d.num}"`, { headers: { Accept: "application/json" } })
  if (((await ex.json()).Invoices ?? []).length) { console.log(`  ${d.num} already in Xero — skip`); continue }
  if (!(d.contact in cache)) cache[d.contact] = await contactId(d.contact)
  const cid = cache[d.contact]
  const vat = d.tax === "INPUT2" ? d.net * 0.2 : 0
  console.log(`  ${d.num.padEnd(14)} ${d.contact.slice(0,20).padEnd(21)} ${d.date}  net ${d.net.toFixed(2).padStart(9)}  VAT ${vat.toFixed(2).padStart(8)}  gross ${(d.net+vat).toFixed(2).padStart(9)}`)
  if (!EXECUTE || !cid) continue
  const r = await xeroFetch("/api.xro/2.0/Invoices", { method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ Invoices: [{ Type: "ACCPAY", InvoiceNumber: d.num,
      Contact: { ContactID: cid }, Date: d.date, DueDate: d.date, Status: "AUTHORISED",
      LineAmountTypes: "Exclusive",
      LineItems: [{ Description: d.desc, Quantity: 1, UnitAmount: d.net, AccountCode: d.acct, TaxType: d.tax }] }] }) })
  const txt = await r.text()
  if (!r.ok) { console.log(`      !! ${r.status}: ${JSON.stringify(JSON.parse(txt).Elements?.[0]?.ValidationErrors ?? txt).slice(0,200)}`); continue }
  const now = JSON.parse(txt).Invoices?.[0]
  console.log(`      OK -> total ${now?.Total}  VAT ${now?.TotalTax}  ${now?.Status}`)
}
process.exit(0)
