import { xeroGet, xeroFetch } from "../lib/xero/client"
const NUM="HOWDENS-KITCHEN-2026-08", NET=20215.29
const ex=await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${NUM}"`,{headers:{Accept:"application/json"}})
if(((await ex.json()).Invoices??[]).length){ console.log("already in Xero"); process.exit(0) }
const g=await xeroGet(`/api.xro/2.0/Contacts?where=Name=="Howdens Joinery"`,{headers:{Accept:"application/json"}})
let cid=((await g.json()).Contacts??[])[0]?.ContactID
if(!cid){
  const c=await xeroFetch("/api.xro/2.0/Contacts",{method:"POST",
    headers:{Accept:"application/json","Content-Type":"application/json"},
    body:JSON.stringify({Contacts:[{Name:"Howdens Joinery"}]})})
  cid=((await c.json()).Contacts??[])[0]?.ContactID; console.log("created contact Howdens Joinery")
}
const acc=await xeroGet("/api.xro/2.0/Accounts",{headers:{Accept:"application/json"}})
const codes=new Set(((await acc.json()).Accounts??[]).map((a:any)=>a.Code))
const code=codes.has("1112")?"1112":"4000"
const r=await xeroFetch("/api.xro/2.0/Invoices",{method:"POST",
  headers:{Accept:"application/json","Content-Type":"application/json"},
  body:JSON.stringify({Invoices:[{Type:"ACCPAY",InvoiceNumber:NUM,Contact:{ContactID:cid},
    Date:"2026-08-05",DueDate:"2026-08-05",Status:"AUTHORISED",LineAmountTypes:"Exclusive",
    LineItems:[{Description:"Howdens kitchen, HJ Sherborne. Bought on Amex, settled 05/08 and 02/09. VAT invoice still to be obtained from Howdens.",
      Quantity:1,UnitAmount:NET,AccountCode:code,TaxType:"INPUT2"}]}]})})
const txt=await r.text()
if(!r.ok){ console.log(`!! ${r.status}: ${JSON.stringify(JSON.parse(txt).Elements?.[0]?.ValidationErrors??txt).slice(0,200)}`); process.exit(1) }
const now=JSON.parse(txt).Invoices?.[0]
console.log(`Xero bill created: total ${now?.Total}  VAT ${now?.TotalTax}  account ${code}  ${now?.Status}`)
process.exit(0)
