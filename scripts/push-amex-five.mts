import { xeroGet, xeroFetch } from "../lib/xero/client"
const EXECUTE = process.argv.includes("--execute")
const NEW: [string,string,number][] = [
  ["78565469","2026-08-14",240.01],["78566952","2026-08-24",94.04],["78566797","2026-08-24",213.10],
  ["78565522","2026-08-24",569.68],["78596849","2026-08-28",5158.35],
]
const g = await xeroGet(`/api.xro/2.0/Contacts?where=Name=="Bradfords"`, { headers: { Accept: "application/json" } })
const cid = ((await g.json()).Contacts ?? [])[0]?.ContactID
console.log(`Bradfords contact ${cid}`)
for (const [num, date, net] of NEW) {
  const ex = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${num}"`, { headers: { Accept: "application/json" } })
  if (((await ex.json()).Invoices ?? []).length) { console.log(`  ${num} already in Xero — skip`); continue }
  console.log(`  ${num}  ${date}  net ${net.toFixed(2).padStart(9)}  VAT ${(net*0.2).toFixed(2).padStart(8)}`)
  if (!EXECUTE || !cid) continue
  const r = await xeroFetch("/api.xro/2.0/Invoices", { method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ Invoices: [{ Type: "ACCPAY", InvoiceNumber: num, Contact: { ContactID: cid },
      Date: date, DueDate: date, Status: "AUTHORISED", LineAmountTypes: "Exclusive",
      LineItems: [{ Description: `Bradfords invoice ${num} — settled on Amex 30/09/2026`, Quantity: 1,
        UnitAmount: net, AccountCode: "1000", TaxType: "INPUT2" }] }] }) })
  const txt = await r.text()
  if (!r.ok) { console.log(`      !! ${r.status}: ${JSON.stringify(JSON.parse(txt).Elements?.[0]?.ValidationErrors ?? txt).slice(0,180)}`); continue }
  const now = JSON.parse(txt).Invoices?.[0]
  console.log(`      OK -> total ${now?.Total}  VAT ${now?.TotalTax}  ${now?.Status}`)
}
process.exit(0)
