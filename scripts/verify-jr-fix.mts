import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const r = await xeroGet("/api.xro/2.0/BankTransactions/ee5b4c8f-7dea-456e-84b4-4cb1de2f3b80", { headers: { Accept: "application/json" } })
const t = ((await r.json()).BankTransactions ?? [])[0]
console.log(`Jordan Reeves ${parse(t.Date)}`)
console.log(`  total ${t.Total}  (was 1080.00)`)
console.log(`  VAT   ${t.TotalTax}  (was 180.00)`)
console.log(`  reconciled ${t.IsReconciled}   status ${t.Status}`)
for (const l of t.LineItems ?? []) console.log(`  line: acct ${l.AccountCode}  ${l.TaxType}  "${l.Description}"`)
process.exit(0)
