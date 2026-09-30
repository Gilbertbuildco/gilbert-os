import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const r=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const spend=((await r.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND")
for (const [label,rx] of [["George Wilson",/wilson/i],["R. Smith / Smith",/smith/i],["Mayflower",/mayflow/i],["StairBox",/stair/i],["Rhys Harvey",/rhys|harvey/i]] as [string,RegExp][]) {
  const hits=spend.filter((t:any)=>rx.test(String(t.Contact?.Name??"")))
  console.log(`\n${label}: ${hits.length} payments`)
  for(const t of hits.sort((a:any,b:any)=>parse(a.Date).localeCompare(parse(b.Date))))
    console.log(`  ${parse(t.Date)}  ${String(t.Contact?.Name).slice(0,26).padEnd(27)} ${String(t.Total).padStart(10)}  VAT ${String(t.TotalTax).padStart(8)}`)
  console.log(`  total ${hits.reduce((s:number,t:any)=>s+t.Total,0).toFixed(2)}`)
}
process.exit(0)
