import { readFileSync } from "node:fs"
const bills = JSON.parse(readFileSync("/tmp/vat-bills.json", "utf8"))
const d = (s: string) => (s ?? "").slice(0, 10)
const norm = (s: string) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
const money = (n: number) => (n ?? 0).toFixed(2).padStart(10)

// Xero's Date field arrives as /Date(ms+0000)/
const parse = (v: any) => {
  if (!v) return ""
  const m = /\/Date\((\d+)/.exec(String(v))
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : d(String(v))
}

const rows = bills.map((b: any) => ({
  who: b.Contact?.Name ?? "?", num: b.InvoiceNumber ?? "", tax: b.TotalTax ?? 0, tot: b.Total ?? 0,
  date: b.DateString ? d(b.DateString) : parse(b.Date),
  entered: parse(b.UpdatedDateUTC), status: b.Status, id: b.InvoiceID,
}))

console.log("=== LATE CLAIMS: bill dated in an earlier month than when it was entered ===")
console.log("(these are what Xero adds to the current return on top of the current month)\n")
const late = rows.filter((r: any) => r.date && r.entered && r.entered.slice(0, 7) > r.date.slice(0, 7) && r.tax > 0)
late.sort((a: any, b: any) => a.date.localeCompare(b.date))
let lateVat = 0
for (const r of late) { lateVat += r.tax; console.log(`  dated ${r.date}  entered ${r.entered}  VAT ${money(r.tax)}  ${r.who.slice(0, 32).padEnd(32)} ${r.num}`) }
console.log(`\n  ${late.length} late-claim bills carrying VAT ${lateVat.toFixed(2)}`)

console.log("\n=== DUPLICATE RISK: same supplier + same invoice number ===")
const byKey: Record<string, any[]> = {}
for (const r of rows) { const k = `${norm(r.who)}|${norm(r.num)}`; if (norm(r.num)) (byKey[k] ??= []).push(r) }
let dupVat = 0
for (const [k, g] of Object.entries(byKey)) if (g.length > 1) {
  dupVat += g.slice(1).reduce((s, r) => s + r.tax, 0)
  console.log(`  x${g.length}  ${g[0].who} ${g[0].num}  VAT each ${money(g[0].tax)}`)
  for (const r of g) console.log(`        ${r.date}  entered ${r.entered}  ${r.status}  ${r.id}`)
}
if (!dupVat) console.log("  none")

console.log("\n=== DUPLICATE RISK: same supplier + same total, different invoice number ===")
const byAmt: Record<string, any[]> = {}
for (const r of rows) if (r.tot) (byAmt[`${norm(r.who)}|${r.tot.toFixed(2)}`] ??= []).push(r)
for (const [, g] of Object.entries(byAmt)) if (g.length > 1 && new Set(g.map((r) => norm(r.num))).size > 1) {
  console.log(`  x${g.length}  ${g[0].who}  total ${money(g[0].tot)}  VAT ${money(g[0].tax)}`)
  for (const r of g) console.log(`        ${r.date}  ${r.num || "(no number)"}  entered ${r.entered}`)
}
process.exit(0)
