import { writeFileSync } from "node:fs"
import { xeroGet } from "../lib/xero/client"

const bills: any[] = []
for (let page = 1; ; page++) {
  const r = await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${page}&pageSize=100`, { headers: { Accept: "application/json" } })
  const inv = (await r.json()).Invoices ?? []
  bills.push(...inv)
  if (inv.length < 100) break
}
const live = bills.filter((b) => !["DELETED", "VOIDED", "DRAFT"].includes(b.Status))
console.log("live bills:", live.length, "| have LineItems:", live.filter((b) => (b.LineItems ?? []).length).length)

// Fetch line items individually where missing (Xero omits them on list calls)
const need = live.filter((b) => !(b.LineItems ?? []).length)
for (let i = 0; i < need.length; i += 40) {
  const ids = need.slice(i, i + 40).map((b) => b.InvoiceID).join(",")
  const r = await xeroGet(`/api.xro/2.0/Invoices?IDs=${ids}&pageSize=100`, { headers: { Accept: "application/json" } })
  if (!r.ok) { console.log("detail fetch", r.status); break }
  for (const full of (await r.json()).Invoices ?? []) {
    const t = live.find((b) => b.InvoiceID === full.InvoiceID)
    if (t) t.LineItems = full.LineItems ?? []
  }
}
writeFileSync("/tmp/vat-bills.json", JSON.stringify(live))
console.log("with lines now:", live.filter((b) => (b.LineItems ?? []).length).length)

const byType: Record<string, { net: number; tax: number; n: number }> = {}
for (const b of live) for (const l of b.LineItems ?? []) {
  const k = l.TaxType ?? "(none)"
  byType[k] ??= { net: 0, tax: 0, n: 0 }
  byType[k].net += l.LineAmount ?? 0; byType[k].tax += l.TaxAmount ?? 0; byType[k].n++
}
console.log("\nALL PURCHASE LINES BY TAX TYPE")
for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].tax - a[1].tax))
  console.log(`  ${k.padEnd(18)} lines ${String(v.n).padStart(4)}  net ${v.net.toFixed(2).padStart(12)}  VAT ${v.tax.toFixed(2).padStart(11)}`)
process.exit(0)
