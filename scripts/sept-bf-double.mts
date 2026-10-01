import { xeroGet } from "../lib/xero/client"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
for(const id of ["90df1c04-3270-4824-83bd-8d7839edc415","618f98cd-3be9-44c6-a52f-9d5ea8a41b7d"]){
  const r=await xeroGet(`/api.xro/2.0/BankTransactions/${id}`,{headers:{Accept:"application/json"}})
  const t=((await r.json()).BankTransactions??[])[0]
  console.log(`${parse(t.Date)}  ${t.Contact?.Name}  total ${t.Total}  VAT ${t.TotalTax}  lineAmountTypes=${t.LineAmountTypes}`)
  for(const l of t.LineItems??[]) console.log(`   acct ${l.AccountCode}  ${l.TaxType}  "${l.Description??""}"`)
  console.log(`   EDIT: https://go.xero.com/Bank/EditCashReceipt.aspx?invoiceID=${t.BankTransactionID}&accountID=${t.BankAccount?.AccountID}&edit=True&type=INVOICETYPE/CASHPAID`)
}
// Bradfords bills dated or created in September, carrying VAT
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const bf=bills.filter(b=>!["DELETED","VOIDED"].includes(b.Status)&&/bradford/i.test(String(b.Contact?.Name??"")))
const sept=bf.filter(b=>(b.DateString??"").slice(0,7)==="2026-09"||parse(b.UpdatedDateUTC)>="2026-09-01")
console.log(`\nBradfords bills dated or entered in September: ${sept.length}, VAT on them ${sept.reduce((s,b)=>s+(b.TotalTax??0),0).toFixed(2)}`)
console.log(`The two September payments claim ${(833.33+1256.86).toFixed(2)} of VAT for the same trading account.`)
console.log(`If both stand, that 2,090.19 is claimed twice in the September return.`)
process.exit(0)
