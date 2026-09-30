import { xeroGet, xeroFetch } from "../lib/xero/client"
const EXECUTE = process.argv.includes("--execute")
const DOCS = [
  { contact: "Carrarino Limited", num: "INV-1579", date: "2026-09-30", net: 1255.00, acct: "1112", desc: "Plot 1 deposit — supply and install 20mm Quartz Alaska White worktop" },
  { contact: "Bradfords", num: "78706882", date: "2026-09-26", net: 87.55, acct: "1000", desc: "Bradfords invoice 78706882, order 29167572" },
  { contact: "Bradfords", num: "78710153", date: "2026-09-28", net: 1675.19, acct: "1000", desc: "Bradfords invoice 78710153, order 29164305" },
  { contact: "Mayflower Kitchens", num: "685", date: "2026-09-30", net: 11930.14, acct: "1112", desc: "Plot 3 Belgravia shell kitchen and Aldana Stone utility door furniture" },
]
const cache: Record<string,string|null> = {}
async function cid(name: string) {
  if (name in cache) return cache[name]
  const g = await xeroGet(`/api.xro/2.0/Contacts?where=Name=="${name}"`, { headers: { Accept: "application/json" } })
  const c = ((await g.json()).Contacts ?? [])[0]
  if (c) return (cache[name] = c.ContactID)
  if (!EXECUTE) { console.log(`  would create contact ${name}`); return (cache[name] = null) }
  const r = await xeroFetch("/api.xro/2.0/Contacts", { method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ Contacts: [{ Name: name }] }) })
  if (!r.ok) { console.log(`  !! contact ${name}: ${(await r.text()).slice(0,140)}`); return (cache[name] = null) }
  console.log(`  created contact ${name}`)
  return (cache[name] = ((await r.json()).Contacts ?? [])[0]?.ContactID)
}
for (const d of DOCS) {
  const ex = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${d.num}"`, { headers: { Accept: "application/json" } })
  if (((await ex.json()).Invoices ?? []).length) { console.log(`  ${d.num} already in Xero — skip`); continue }
  const id = await cid(d.contact)
  const vat = d.net * 0.2
  console.log(`  ${d.num.padEnd(12)} ${d.contact.slice(0,20).padEnd(21)} net ${d.net.toFixed(2).padStart(9)}  VAT ${vat.toFixed(2).padStart(8)}  gross ${(d.net+vat).toFixed(2).padStart(9)}`)
  if (!EXECUTE || !id) continue
  const r = await xeroFetch("/api.xro/2.0/Invoices", { method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ Invoices: [{ Type: "ACCPAY", InvoiceNumber: d.num, Contact: { ContactID: id },
      Date: d.date, DueDate: d.date, Status: "AUTHORISED", LineAmountTypes: "Exclusive",
      LineItems: [{ Description: d.desc, Quantity: 1, UnitAmount: d.net, AccountCode: d.acct, TaxType: "INPUT2" }] }] }) })
  const txt = await r.text()
  if (!r.ok) { console.log(`      !! ${r.status}: ${JSON.stringify(JSON.parse(txt).Elements?.[0]?.ValidationErrors ?? txt).slice(0,180)}`); continue }
  const now = JSON.parse(txt).Invoices?.[0]
  console.log(`      OK -> total ${now?.Total}  VAT ${now?.TotalTax}  ${now?.Status}`)
}
process.exit(0)
