import { readFileSync } from "node:fs"
import { xeroGet } from "../lib/xero/client"
const parse = (v: any) => { const m = /\/Date\((\d+)/.exec(String(v ?? "")); return m ? new Date(Number(m[1])).toISOString().slice(0,10) : "" }
const bank = JSON.parse(readFileSync("/tmp/vat-bank.json", "utf8"))
const bills = JSON.parse(readFileSync("/tmp/vat-bills.json", "utf8"))

console.log("=== The 10 coded Bradfords SPEND transactions ===")
for (const b of bank.filter((x: any) => x.Type === "SPEND" && /bradford/i.test(x.Contact?.Name ?? ""))) {
  const r = await xeroGet(`/api.xro/2.0/BankTransactions/${b.BankTransactionID}`, { headers: { Accept: "application/json" } })
  const f = ((await r.json()).BankTransactions ?? [])[0] ?? {}
  console.log(`  ${parse(f.Date)}  ${String(f.Total).padStart(10)}  VAT ${String(f.TotalTax).padStart(9)}  reconciled=${f.IsReconciled}  status=${f.Status}  ${f.BankTransactionID}`)
}
console.log("\n=== Bradfords bills: are they already marked paid? ===")
const bf = bills.filter((b: any) => /bradford/i.test(b.Contact?.Name ?? ""))
const byStatus: Record<string, {n:number; amt:number; due:number}> = {}
for (const b of bf) { byStatus[b.Status] ??= {n:0,amt:0,due:0}; byStatus[b.Status].n++; byStatus[b.Status].amt += b.Total; byStatus[b.Status].due += b.AmountDue ?? 0 }
for (const [k,v] of Object.entries(byStatus)) console.log(`  ${k.padEnd(12)} n=${String(v.n).padStart(3)}  total ${v.amt.toFixed(2).padStart(11)}  outstanding ${v.due.toFixed(2).padStart(11)}`)
console.log(`\n  bills dated <= 2026-06-30: ${bf.filter((b:any)=>(b.DateString??"").slice(0,10) <= "2026-06-30").length}`)
console.log(`  bills dated >= 2026-07-01: ${bf.filter((b:any)=>(b.DateString??"").slice(0,10) >= "2026-07-01").length}`)
process.exit(0)
