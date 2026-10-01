import { xeroGet } from "../lib/xero/client"
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const aw=bills.filter(b=>b.Status==="AUTHORISED")
console.log(`awaiting payment now: ${aw.length} bills, ${aw.reduce((s,b)=>s+(b.AmountDue??0),0).toFixed(2)}`)
const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const sp=((await bt.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND")
const vatOn=sp.filter((t:any)=>(t.TotalTax??0)>0)
console.log(`coded SPEND: ${sp.length} total ${sp.reduce((s:number,t:any)=>s+t.Total,0).toFixed(2)}`)
console.log(`  of those still claiming VAT: ${vatOn.length}, VAT ${vatOn.reduce((s:number,t:any)=>s+t.TotalTax,0).toFixed(2)}`)
const byS:Record<string,{n:number;v:number;t:number}>={}
for(const t of vatOn){const k=t.Contact?.Name??"?"; byS[k]??={n:0,v:0,t:0}; byS[k].n++; byS[k].v+=t.TotalTax; byS[k].t+=t.Total}
console.log("\n  payments still carrying VAT — these must be de-VATed BEFORE Remove & Redo,")
console.log("  or the VAT gets removed along with them:")
for(const [k,v] of Object.entries(byS).sort((a,b)=>b[1].v-a[1].v).slice(0,10))
  console.log(`    ${k.slice(0,26).padEnd(27)} ${String(v.n).padStart(3)}  gross ${v.t.toFixed(2).padStart(10)}  VAT ${v.v.toFixed(2).padStart(9)}`)
process.exit(0)
