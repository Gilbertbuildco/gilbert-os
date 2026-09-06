import { readFileSync } from "node:fs"
const bills = JSON.parse(readFileSync("/tmp/vat-bills.json", "utf8"))
  .filter((b: any) => /bradford/i.test(b.Contact?.Name ?? ""))
  .map((b: any) => ({ num: b.InvoiceNumber, date: (b.DateString ?? "").slice(0, 10), gross: b.Total, vat: b.TotalTax, status: b.Status, due: b.AmountDue ?? 0 }))
  .sort((a: any, b: any) => a.date.localeCompare(b.date))

const pays = [
  { date: "2026-02-18", amt: 154.64 }, { date: "2026-04-07", amt: 8209.53 },
  { date: "2026-05-01", amt: 10772.15 }, { date: "2026-05-22", amt: 18150.19 },
  { date: "2026-06-01", amt: 16321.00 }, { date: "2026-06-02", amt: 321.00 },
  { date: "2026-07-01", amt: 4457.58 }, { date: "2026-07-01", amt: 6011.59 },
  { date: "2026-07-24", amt: 10000.00 }, { date: "2026-07-30", amt: 9629.89 },
]
const p = (n: number) => Math.round(n * 100)
console.log("Bradfords bills:", bills.length, "gross", bills.reduce((s: number, b: any) => s + b.gross, 0).toFixed(2))
console.log("Amex payments  :", pays.length, "gross", pays.reduce((s, x) => s + x.amt, 0).toFixed(2))

// exact single-invoice matches
console.log("\n--- payments that exactly equal one invoice ---")
const used = new Set<string>()
for (const pay of pays) {
  const hit = bills.find((b: any) => p(b.gross) === p(pay.amt) && !used.has(b.num))
  if (hit) { used.add(hit.num); console.log(`  ${pay.date}  ${pay.amt.toFixed(2).padStart(10)}  ->  ${hit.num}  (${hit.date}, VAT ${hit.vat.toFixed(2)})`) }
}
// subset-sum for the rest, over invoices dated before the payment
console.log("\n--- payments matched to a combination of invoices ---")
for (const pay of pays) {
  if ([...used].some((u) => bills.find((b: any) => b.num === u && p(b.gross) === p(pay.amt)))) continue
  const pool = bills.filter((b: any) => !used.has(b.num) && b.date <= pay.date)
  const target = p(pay.amt)
  const memo = new Map<string, string[] | null>()
  const solve = (i: number, rem: number, depth: number): string[] | null => {
    if (rem === 0) return []
    if (i >= pool.length || rem < 0 || depth > 14) return null
    const k = `${i}|${rem}`
    if (memo.has(k)) return memo.get(k)!
    const take = solve(i + 1, rem - p(pool[i].gross), depth + 1)
    let out: string[] | null = take ? [pool[i].num, ...take] : solve(i + 1, rem, depth)
    memo.set(k, out); return out
  }
  const sol = solve(0, target, 0)
  if (sol) { sol.forEach((n) => used.add(n)); console.log(`  ${pay.date}  ${pay.amt.toFixed(2).padStart(10)}  ->  ${sol.length} invoices: ${sol.join(", ")}`) }
  else console.log(`  ${pay.date}  ${pay.amt.toFixed(2).padStart(10)}  ->  NO COMBINATION FOUND from ${pool.length} candidates`)
}
const unmatched = bills.filter((b: any) => !used.has(b.num))
console.log(`\nunallocated invoices: ${unmatched.length}, gross ${unmatched.reduce((s: number, b: any) => s + b.gross, 0).toFixed(2)}`)
process.exit(0)
