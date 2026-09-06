import { xeroGet } from "../lib/xero/client"
const P = [
  ["2026-07-01", "5185646a-9ac0-4a0d-8d20-8ed1c1363b39", 4457.58, 742.93],
  ["2026-07-01", "ca257fdf-69f4-4b65-b54d-136efa1331ae", 6011.59, 1001.93],
  ["2026-07-24", "7287e78a-10e5-48e9-b09a-14d085994b21", 10000.00, 1666.67],
  ["2026-07-30", "1efff7cb-662c-42bf-bc9b-fa4ef8d5ba79", 9629.89, 1604.98],
] as const
let removed = 0, bad = 0
console.log("JULY AMEX PAYMENTS")
for (const [date, id, total, wasVat] of P) {
  const r = await xeroGet(`/api.xro/2.0/BankTransactions/${id}`, { headers: { Accept: "application/json" } })
  const t = ((await r.json()).BankTransactions ?? [])[0]
  const okTotal = Math.abs(t.Total - total) < 0.005
  const okVat = (t.TotalTax ?? 0) === 0
  if (!okTotal || !okVat || !t.IsReconciled) bad++
  if (okVat) removed += wasVat
  console.log(`  ${date}  total ${String(t.Total).padStart(9)} ${okTotal ? "ok" : "CHANGED!"}   VAT ${String(t.TotalTax).padStart(8)} ${okVat ? "ok" : "STILL SET!"}   reconciled=${t.IsReconciled}  contact=${t.Contact?.Name}`)
}
console.log("\nAPRIL BILLS")
let billRemoved = 0
for (const [num, wasVat, expect] of [["77983446", 3233.40, 0], ["77983461", 8511.80, 5791.63]] as const) {
  const s = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${num}"`, { headers: { Accept: "application/json" } })
  const i = ((await s.json()).Invoices ?? [])[0]
  billRemoved += wasVat - i.TotalTax
  console.log(`  ${num}  total ${i.Total.toFixed(2).padStart(9)}  VAT ${i.TotalTax.toFixed(2).padStart(8)} ${Math.abs(i.TotalTax - expect) < 0.005 ? "ok" : "UNEXPECTED"}`)
}
const tot = removed + billRemoved
console.log(`\n  payments: ${removed.toFixed(2)}   bills: ${billRemoved.toFixed(2)}   TOTAL OFF THE RECLAIM: ${tot.toFixed(2)}`)
console.log(`  July return: 40542.63 -> ${(40542.63 - tot).toFixed(2)}`)
console.log(bad ? `\n  !! ${bad} payment(s) not right - check` : "\n  all four payments correct, totals unchanged, still reconciled")
process.exit(0)
