import { readFileSync } from "node:fs"
const bank = JSON.parse(readFileSync("/tmp/vat-bank.json", "utf8"))
const bills = JSON.parse(readFileSync("/tmp/vat-bills.json", "utf8"))
const parse = (v: any) => { const m = /\/Date\((\d+)/.exec(String(v ?? "")); return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : String(v ?? "").slice(0, 10) }

console.log("=== The 10 Bradfords bank payments: how are they coded? ===")
for (const b of bank.filter((x: any) => x.Type === "SPEND" && /bradford/i.test(x.Contact?.Name ?? ""))) {
  const l = (b.LineItems ?? [])[0] ?? {}
  console.log(`  ${parse(b.Date)}  ${b.Total.toFixed(2).padStart(10)}  VAT ${(b.TotalTax ?? 0).toFixed(2).padStart(9)}  acct ${String(l.AccountCode ?? "?").padEnd(6)} ${String(l.TaxType ?? "?").padEnd(14)} ${(l.Description ?? "").slice(0, 40)}`)
}
const bfBank = bank.filter((x: any) => x.Type === "SPEND" && /bradford/i.test(x.Contact?.Name ?? ""))
const bfBill = bills.filter((x: any) => /bradford/i.test(x.Contact?.Name ?? ""))
console.log(`\n  Bradfords bank payments : ${bfBank.length} txns, gross ${bfBank.reduce((s: number, b: any) => s + b.Total, 0).toFixed(2)}, VAT ${bfBank.reduce((s: number, b: any) => s + (b.TotalTax ?? 0), 0).toFixed(2)}`)
console.log(`  Bradfords bills         : ${bfBill.length} bills, gross ${bfBill.reduce((s: number, b: any) => s + b.Total, 0).toFixed(2)}, VAT ${bfBill.reduce((s: number, b: any) => s + (b.TotalTax ?? 0), 0).toFixed(2)}`)
console.log("  -> the SAME Bradfords purchases, recorded twice: once as coded payments, once as bills")

console.log("\n=== VAT by MONTH (monthly returns), bills vs bank ===")
const m: Record<string, { bill: number; bank: number; lateBill: number }> = {}
for (const b of bills) { const k = (b.DateString ? b.DateString.slice(0,7) : parse(b.Date).slice(0,7)); m[k] ??= { bill: 0, bank: 0, lateBill: 0 }
  m[k].bill += b.TotalTax ?? 0
  if (parse(b.UpdatedDateUTC).slice(0,7) > k) m[k].lateBill += b.TotalTax ?? 0 }
for (const b of bank) { if (b.Type !== "SPEND") continue; const k = parse(b.Date).slice(0,7); m[k] ??= { bill: 0, bank: 0, lateBill: 0 }; m[k].bank += b.TotalTax ?? 0 }
console.log("month      bills VAT    bank VAT    TOTAL      of which entered late")
for (const k of Object.keys(m).sort()) { const v = m[k]
  console.log(`${k}  ${v.bill.toFixed(2).padStart(10)}  ${v.bank.toFixed(2).padStart(10)}  ${(v.bill + v.bank).toFixed(2).padStart(10)}   ${v.lateBill.toFixed(2).padStart(10)}`) }
process.exit(0)
