/**
 * Suppliers whose INVOICES carry no VAT but whose PAYMENTS in Xero claim it.
 * That is input tax reclaimed on a supply that never charged any - the Jordan
 * Reeves £180 generalised. Reports only.
 */
import { pool } from "../lib/db"
import { xeroGet } from "../lib/xero/client"
const parse = (v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}

const inv = await pool.query(
  `select s.name, count(*) n, sum(i.vat)::numeric vat, sum(i.gross)::numeric gross
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.transaction_type='invoice' group by 1`)
const zeroVat = new Map<string, any>()
for (const r of inv.rows) if (Number(r.vat) === 0) zeroVat.set(String(r.name).toLowerCase(), r)

const g = await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000", { headers: { Accept: "application/json" } })
const bank = ((await g.json()).BankTransactions ?? []).filter((t:any)=>t.Type==="SPEND" && t.Status==="AUTHORISED" && (t.TotalTax ?? 0) > 0)

console.log("SUPPLIER INVOICES CARRY NO VAT, BUT XERO PAYMENTS CLAIM IT\n")
let total = 0
const byContact: Record<string, {n:number; tax:number; gross:number; dates:string[]}> = {}
for (const t of bank) {
  const c = String(t.Contact?.Name ?? "")
  const key = c.toLowerCase()
  const hit = [...zeroVat.keys()].find(k => k.includes(key.split(" ")[0]) || key.includes(k.split(" ")[0]))
  if (!hit) continue
  byContact[c] ??= {n:0,tax:0,gross:0,dates:[]}
  byContact[c].n++; byContact[c].tax += t.TotalTax; byContact[c].gross += t.Total; byContact[c].dates.push(parse(t.Date))
}
for (const [c,v] of Object.entries(byContact).sort((a,b)=>b[1].tax-a[1].tax)) {
  total += v.tax
  console.log(`  ${c.slice(0,28).padEnd(29)} ${String(v.n).padStart(2)} payments  gross ${v.gross.toFixed(2).padStart(10)}  VAT claimed ${v.tax.toFixed(2).padStart(9)}   ${v.dates.sort()[0]}..${v.dates.sort().slice(-1)[0]}`)
}
console.log(`\n  input VAT claimed on zero-VAT suppliers: ${total.toFixed(2)}`)
process.exit(0)
