import { writeFileSync, readFileSync } from "node:fs"
import { xeroGet } from "../lib/xero/client"
const parse = (v: any) => { const m = /\/Date\((\d+)/.exec(String(v ?? "")); return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : String(v ?? "").slice(0, 10) }

const r = await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000", { headers: { Accept: "application/json" } })
const bank = ((await r.json()).BankTransactions ?? []).filter((b: any) => b.Status === "AUTHORISED")
writeFileSync("/tmp/vat-bank.json", JSON.stringify(bank))

const spend = bank.filter((b: any) => b.Type === "SPEND")
const withVat = spend.filter((b: any) => (b.TotalTax ?? 0) > 0)
console.log(`SPEND transactions: ${spend.length}  |  carrying VAT: ${withVat.length}`)
console.log(`Input VAT sitting on bank payments: ${withVat.reduce((s: number, b: any) => s + b.TotalTax, 0).toFixed(2)}\n`)

const by: Record<string, { n: number; tax: number; tot: number; dates: string[] }> = {}
for (const b of withVat) {
  const k = b.Contact?.Name ?? "(no contact)"
  by[k] ??= { n: 0, tax: 0, tot: 0, dates: [] }
  by[k].n++; by[k].tax += b.TotalTax; by[k].tot += b.Total; by[k].dates.push(parse(b.Date))
}
console.log("VAT CLAIMED VIA BANK PAYMENTS, BY SUPPLIER")
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].tax - a[1].tax))
  console.log(`  ${k.slice(0, 34).padEnd(34)} n=${String(v.n).padStart(3)}  gross ${v.tot.toFixed(2).padStart(11)}  VAT ${v.tax.toFixed(2).padStart(10)}   ${v.dates.sort()[0]}..${v.dates.sort().slice(-1)[0]}`)

// Which of those suppliers ALSO have bills carrying VAT -> double-claim candidates
const bills = JSON.parse(readFileSync("/tmp/vat-bills.json", "utf8"))
const billVat: Record<string, number> = {}
for (const b of bills) { const k = b.Contact?.Name ?? "?"; billVat[k] = (billVat[k] ?? 0) + (b.TotalTax ?? 0) }
console.log("\n*** SUPPLIERS WITH VAT ON *BOTH* BILLS AND BANK PAYMENTS ***")
let risk = 0
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].tax - a[1].tax)) {
  const bv = billVat[k] ?? 0
  if (bv > 0) { risk += Math.min(bv, v.tax); console.log(`  ${k.slice(0, 34).padEnd(34)} bills VAT ${bv.toFixed(2).padStart(10)}   bank VAT ${v.tax.toFixed(2).padStart(10)}`) }
}
console.log(`\n  overlap exposure (lower of the two per supplier): ${risk.toFixed(2)}`)
process.exit(0)
