import { xeroGet } from "../lib/xero/client"
const parse = (v: any) => { const m = /\/Date\((\d+)/.exec(String(v ?? "")); return m ? new Date(Number(m[1])).toISOString().slice(0,10) : String(v ?? "").slice(0,10) }
const hit = (s: string) => /ranger|270 adventure|YS69/i.test(s ?? "")

// every bill, incl. voided/deleted, so a duplicate that was voided still shows
const bills: any[] = []
for (let p = 1; ; p++) {
  const r = await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`, { headers: { Accept: "application/json" } })
  const inv = (await r.json()).Invoices ?? []
  bills.push(...inv); if (inv.length < 100) break
}
console.log("=== BILLS mentioning the Ranger / 270 Adventure ===")
for (const b of bills) {
  if (!hit(b.Contact?.Name ?? "") && !hit(b.InvoiceNumber ?? "") && !hit(b.Reference ?? "")) continue
  console.log(`  ${parse(b.Date)}  ${b.Status.padEnd(10)}  ${String(b.InvoiceNumber).padEnd(10)}  total ${String(b.Total).padStart(9)}  VAT ${String(b.TotalTax).padStart(8)}  ${b.Contact?.Name}  entered ${parse(b.UpdatedDateUTC)}`)
}
// anything at all with the tell-tale amounts
console.log("\n=== ANY bill at 19000 / 15833.33 / VAT 3166.67 ===")
for (const b of bills) {
  if (Math.abs((b.Total ?? 0) - 19000) < 0.02 || Math.abs((b.TotalTax ?? 0) - 3166.67) < 0.02)
    console.log(`  ${parse(b.Date)}  ${b.Status.padEnd(10)}  ${String(b.InvoiceNumber).padEnd(10)}  total ${b.Total}  VAT ${b.TotalTax}  ${b.Contact?.Name}`)
}
// bank side
const r2 = await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000", { headers: { Accept: "application/json" } })
const bank = ((await r2.json()).BankTransactions ?? [])
console.log("\n=== BANK transactions mentioning it, or at those amounts ===")
for (const t of bank) {
  const amounts = Math.abs((t.Total ?? 0) - 19000) < 0.02 || Math.abs((t.TotalTax ?? 0) - 3166.67) < 0.02
  if (!hit(t.Contact?.Name ?? "") && !hit(t.Reference ?? "") && !amounts) continue
  console.log(`  ${parse(t.Date)}  ${t.Type}  ${t.Status}  total ${String(t.Total).padStart(9)}  VAT ${String(t.TotalTax).padStart(8)}  ${t.Contact?.Name}  ${t.Reference ?? ""}`)
}
process.exit(0)
