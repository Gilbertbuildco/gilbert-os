import { readFileSync } from "node:fs"
import { xeroGet } from "../lib/xero/client"
const bank = JSON.parse(readFileSync("/tmp/vat-bank.json", "utf8"))
const parse = (v: any) => { const m = /\/Date\((\d+)/.exec(String(v ?? "")); return m ? new Date(Number(m[1])).toISOString().slice(0,10) : "" }
const targets = bank.filter((x: any) => x.Type === "SPEND" && /bradford|travis|sherborne|hopkins|lazenby|scope/i.test(x.Contact?.Name ?? ""))
console.log("checking coding on", targets.length, "overlapping payments\n")
const acc: Record<string, { n: number; tax: number }> = {}
for (const t of targets.slice(0, 24)) {
  const r = await xeroGet(`/api.xro/2.0/BankTransactions/${t.BankTransactionID}`, { headers: { Accept: "application/json" } })
  if (!r.ok) continue
  const full = ((await r.json()).BankTransactions ?? [])[0]
  for (const l of full?.LineItems ?? []) {
    const k = `${l.AccountCode ?? "?"} ${l.TaxType ?? "?"}`
    acc[k] ??= { n: 0, tax: 0 }; acc[k].n++; acc[k].tax += l.TaxAmount ?? 0
    console.log(`  ${parse(full.Date)} ${String(full.Contact?.Name).slice(0,20).padEnd(20)} acct ${String(l.AccountCode).padEnd(5)} ${String(l.TaxType).padEnd(14)} VAT ${(l.TaxAmount ?? 0).toFixed(2).padStart(9)}  ${(l.Description ?? "").slice(0,34)}`)
  }
}
console.log("\nsummary by account + tax type:")
for (const [k, v] of Object.entries(acc).sort((a,b) => b[1].tax - a[1].tax)) console.log(`  ${k.padEnd(24)} n=${String(v.n).padStart(3)}  VAT ${v.tax.toFixed(2).padStart(10)}`)
process.exit(0)
