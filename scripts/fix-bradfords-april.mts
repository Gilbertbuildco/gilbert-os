/**
 * The two April Bradfords invoices land in the July return as late claims,
 * but their VAT was already recovered through the Amex payments in Apr/May/Jun.
 * Setting them to No VAT removes the second claim without touching the old
 * payments, which stay exactly as filed.
 *
 * Going forward the invoices carry the VAT and the Amex payment does not -
 * so only these two pre-July bills are affected here.
 */
import { xeroGet, xeroFetch } from "../lib/xero/client"
const EXECUTE = process.argv.includes("--execute")
const NUMS = ["77983446", "77983461"]

for (const num of NUMS) {
  const g = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${num}"`, { headers: { Accept: "application/json" } })
  const stub = ((await g.json()).Invoices ?? [])[0]
  if (!stub) { console.log(num, "not found"); continue }
  const gf = await xeroGet(`/api.xro/2.0/Invoices/${stub.InvoiceID}`, { headers: { Accept: "application/json" } })
  const inv = ((await gf.json()).Invoices ?? [])[0]
  console.log(`\n${num}  ${inv.DateString?.slice(0,10)}  ${inv.Status}  total ${inv.Total}  VAT ${inv.TotalTax}  amountPaid ${inv.AmountPaid ?? 0}`)
  for (const l of inv.LineItems ?? []) console.log(`   acct ${l.AccountCode}  ${l.TaxType}  net ${l.LineAmount}  vat ${l.TaxAmount}  "${(l.Description ?? "").slice(0,50)}"`)
  if (!EXECUTE) { console.log("   (dry run)"); continue }
  const payload = { InvoiceID: inv.InvoiceID, Type: inv.Type, LineAmountTypes: "Inclusive",
    LineItems: (inv.LineItems ?? []).map((l: any) => ({ LineItemID: l.LineItemID, Description: l.Description,
      Quantity: l.Quantity ?? 1, UnitAmount: Number((((l.LineAmount ?? 0) + (l.TaxAmount ?? 0)) / (l.Quantity ?? 1)).toFixed(4)),
      AccountCode: l.AccountCode, TaxType: "NONE", Tracking: l.Tracking })) }
  const r = await xeroFetch("/api.xro/2.0/Invoices", { method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ Invoices: [payload] }) })
  const txt = await r.text()
  if (!r.ok) { console.log("   !! REFUSED", r.status, JSON.stringify(JSON.parse(txt).Elements?.[0]?.ValidationErrors ?? txt).slice(0,300)); continue }
  const now = JSON.parse(txt).Invoices?.[0]
  console.log(`   OK -> total ${now?.Total}  VAT ${now?.TotalTax}`)
}
process.exit(0)
