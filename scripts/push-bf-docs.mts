/**
 * The three Bradfords documents missing from Xero:
 *   invoice 78322984 (29 Jun, never pushed - its £34.95 has never been claimed)
 *   credit notes 50884851 and 50884868 (28 Aug, windows not delivered in full)
 * All figures verbatim from the PDFs. Credit notes are ACCPAYCREDIT.
 */
import { xeroGet, xeroFetch } from "../lib/xero/client"
const EXECUTE = process.argv.includes("--execute")

const c = await xeroGet(`/api.xro/2.0/Contacts?where=Name=="Bradfords"`, { headers: { Accept: "application/json" } })
const contact = ((await c.json()).Contacts ?? [])[0]
if (!contact) { console.log("Bradfords contact not found"); process.exit(1) }
console.log(`contact: ${contact.Name} ${contact.ContactID}`)

const DOCS = [
  { type: "ACCPAY", num: "78322984", date: "2026-06-29", net: 174.76, vat: 34.95,
    desc: "Bradfords Building Supplies invoice 78322984 — missed from the July payment run" },
  { type: "ACCPAYCREDIT", num: "50884851", date: "2026-08-28", net: 3233.40, vat: 646.68,
    desc: "Plot 1 windows goods not received in full but invoiced. Supplier credit 101249-C1 against invoice 77983446." },
  { type: "ACCPAYCREDIT", num: "50884868", date: "2026-08-28", net: 5247.60, vat: 1049.52,
    desc: "Plot 3 windows goods not received in full but invoiced. Supplier credit 101249-C2 against invoice 77983461." },
]
for (const d of DOCS) {
  const endpoint = d.type === "ACCPAY" ? "Invoices" : "CreditNotes"
  const key = d.type === "ACCPAY" ? "Invoices" : "CreditNotes"
  const numField = d.type === "ACCPAY" ? "InvoiceNumber" : "CreditNoteNumber"
  const ex = await xeroGet(`/api.xro/2.0/${endpoint}?where=${numField}=="${d.num}"`, { headers: { Accept: "application/json" } })
  if (((await ex.json())[key] ?? []).length) { console.log(`  ${d.num} already in Xero — skip`); continue }
  console.log(`  ${d.num}  ${d.type}  ${d.date}  net ${d.net.toFixed(2)}  VAT ${d.vat.toFixed(2)}  gross ${(d.net+d.vat).toFixed(2)}`)
  if (!EXECUTE) continue
  const payload: any = {
    Type: d.type, Contact: { ContactID: contact.ContactID }, Date: d.date, DueDate: d.date, Status: "AUTHORISED",
    LineAmountTypes: "Exclusive",
    LineItems: [{ Description: d.desc, Quantity: 1, UnitAmount: d.net, AccountCode: "1000", TaxType: "INPUT2" }],
  }
  payload[numField] = d.num
  const r = await xeroFetch(`/api.xro/2.0/${endpoint}`, { method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ [key]: [payload] }) })
  const txt = await r.text()
  if (!r.ok) { console.log(`     !! REFUSED ${r.status}: ${JSON.stringify(JSON.parse(txt).Elements?.[0]?.ValidationErrors ?? txt).slice(0,260)}`); continue }
  const now = JSON.parse(txt)[key]?.[0]
  console.log(`     OK -> total ${now?.Total}  VAT ${now?.TotalTax}  status ${now?.Status}`)
}
process.exit(0)
