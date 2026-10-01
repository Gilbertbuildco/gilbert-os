import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const sp=((await bt.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND")
console.log("=== every Crestmoor payment in Xero ===")
for(const t of sp.filter((t:any)=>/crestmoor/i.test(String(t.Contact?.Name??""))).sort((a:any,b:any)=>parse(a.Date).localeCompare(parse(b.Date))))
  console.log(`  ${parse(t.Date)}  ${String(t.Total).padStart(9)}  VAT ${String(t.TotalTax).padStart(7)}  ${(t.LineItems??[])[0]?.Description??""}`)
console.log("\n=== Crestmoor invoices the OS still shows unpaid ===")
const cm=await pool.query(
  `select i.invoice_number n, to_char(i.invoice_date,'YYYY-MM-DD') d, i.gross, i.payment_status
     from invoices i join suppliers s on s.id=i.supplier_id
    where lower(s.name) like '%crestmoor%' and coalesce(i.payment_status,'unpaid')<>'paid' order by i.invoice_date`)
for(const x of cm.rows) console.log(`  ${String(x.n).padEnd(10)} ${x.d}  ${Number(x.gross).toFixed(2).padStart(9)}  ${x.payment_status}`)

console.log("\n=== anything in Xero near the Mark Hodges amounts (605 / 1050 / 1695 / 3350) ===")
for(const t of sp){
  const v=t.Total
  if([605,1050,1695,3350].some(x=>Math.abs(v-x)<0.02))
    console.log(`  ${parse(t.Date)}  ${String(v).padStart(9)}  ${String(t.Contact?.Name).slice(0,28).padEnd(29)} ${(t.LineItems??[])[0]?.Description??""}`)
}
console.log("\n=== payments to Tom Gilbert / cash-like contacts in Sept ===")
for(const t of sp.filter((t:any)=>/gilbert|cash/i.test(String(t.Contact?.Name??""))&&parse(t.Date)>="2026-09-01").sort((a:any,b:any)=>parse(a.Date).localeCompare(parse(b.Date))))
  console.log(`  ${parse(t.Date)}  ${String(t.Total).padStart(9)}  ${String(t.Contact?.Name).slice(0,24).padEnd(25)} ${(t.LineItems??[])[0]?.Description??""}`)
process.exit(0)
