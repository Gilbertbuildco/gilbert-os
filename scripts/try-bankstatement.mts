import { xeroGet } from "../lib/xero/client"
const ACC="1fda9e8f-3084-466b-a905-ab1546671393"
const tries=[
 `/api.xro/2.0/Reports/BankStatement?bankAccountID=${ACC}&fromDate=2026-09-01&toDate=2026-10-01`,
 `/api.xro/2.0/BankTransactions?where=${encodeURIComponent('Status=="AUTHORISED" AND IsReconciled==false')}&pageSize=100`,
 `/api.xro/2.0/BankTransfers`,
 `/api.xro/2.0/Reports/BankSummary?fromDate=2026-09-01&toDate=2026-10-01`,
]
for(const t of tries){
  const r=await xeroGet(t,{headers:{Accept:"application/json"}})
  const txt=await r.text()
  console.log(`\n${r.status}  ${t.slice(0,72)}`)
  if(r.ok){
    try{ const j=JSON.parse(txt)
      const k=Object.keys(j).filter(x=>!["Id","Status","ProviderName","DateTimeUTC"].includes(x))
      console.log(`   keys: ${k.join(", ")}`)
      const arr=j[k[0]]
      if(Array.isArray(arr)) console.log(`   rows: ${arr.length}`)
      if(/BankTransactions/.test(t)&&Array.isArray(arr)) console.log(`   unreconciled found: ${arr.filter((x:any)=>x.IsReconciled===false).length}`)
    }catch{ console.log("   (unparsed)", txt.slice(0,120)) }
  } else console.log(`   ${txt.slice(0,130)}`)
}
process.exit(0)
