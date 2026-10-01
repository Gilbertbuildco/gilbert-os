import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const sp=((await bt.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND"&&/bradford/i.test(String(t.Contact?.Name??"")))
  .sort((a:any,b:any)=>parse(a.Date).localeCompare(parse(b.Date)))
let tot=0, vat=0
console.log("BRADFORDS CODED PAYMENTS — candidates for Remove & Redo\n")
for(const t of sp){ tot+=t.Total; vat+=t.TotalTax??0
  console.log(`  ${parse(t.Date)}  ${String(t.Total).padStart(10)}  VAT ${String(t.TotalTax).padStart(7)}  reconciled=${t.IsReconciled}  ${t.BankTransactionID}`) }
console.log(`\n  ${sp.length} payments, ${tot.toFixed(2)}, VAT still on them ${vat.toFixed(2)}`)
console.log(vat===0 ? "  ALL VAT-FREE — Remove & Redo is VAT-neutral here" : "  !! SOME STILL CARRY VAT — de-VAT first")

const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const open=bills.filter(b=>b.Status==="AUTHORISED"&&/bradford/i.test(String(b.Contact?.Name??"")))
console.log(`\n  Bradfords bills available to match against: ${open.length}, total due ${open.reduce((s,b)=>s+(b.AmountDue??0),0).toFixed(2)}`)
console.log(`  payments to clear ${tot.toFixed(2)} vs bills outstanding ${open.reduce((s,b)=>s+(b.AmountDue??0),0).toFixed(2)}`)
process.exit(0)
