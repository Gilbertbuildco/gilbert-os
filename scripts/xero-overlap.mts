import { xeroGet } from "../lib/xero/client"
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const live=bills.filter(b=>!["DELETED","VOIDED","DRAFT"].includes(b.Status))
const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const spend=((await bt.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND")
const norm=(s:string)=>String(s??"").toLowerCase().replace(/[^a-z]/g,"").slice(0,9)
const agg:Record<string,{bills:number;bn:number;spend:number;sn:number;name:string}>={}
for(const b of live){const k=norm(b.Contact?.Name); agg[k]??={bills:0,bn:0,spend:0,sn:0,name:b.Contact?.Name??"?"}; agg[k].bills+=b.Total??0; agg[k].bn++}
for(const t of spend){const k=norm(t.Contact?.Name); agg[k]??={bills:0,bn:0,spend:0,sn:0,name:t.Contact?.Name??"?"}; agg[k].spend+=t.Total??0; agg[k].sn++}
const rows=Object.values(agg).filter(a=>a.bills>0&&a.spend>0).sort((a,b)=>Math.min(b.bills,b.spend)-Math.min(a.bills,a.spend))
console.log("SUPPLIERS WITH BOTH BILLS AND CODED PAYMENTS — the cost is in Xero twice\n")
console.log("supplier                       bills      as bills   payments   as spend    overlap")
let overlap=0
for(const a of rows){
  const ov=Math.min(a.bills,a.spend); overlap+=ov
  console.log(`  ${a.name.slice(0,26).padEnd(27)} ${String(a.bn).padStart(3)} ${a.bills.toFixed(2).padStart(11)} ${String(a.sn).padStart(5)} ${a.spend.toFixed(2).padStart(11)} ${ov.toFixed(2).padStart(11)}`)
}
console.log(`\n  suppliers affected: ${rows.length}`)
console.log(`  cost potentially double-counted: ${overlap.toFixed(2)}`)
const onlySpend=Object.values(agg).filter(a=>a.bills===0&&a.spend>0)
console.log(`\n  suppliers with ONLY coded payments (no bills — no invoice-level record): ${onlySpend.length}, ${onlySpend.reduce((s,a)=>s+a.spend,0).toFixed(2)}`)
process.exit(0)
