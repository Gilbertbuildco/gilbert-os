import { xeroGet, xeroFetch } from "../lib/xero/client"
const DOCS=[
 {contact:"S. Morris Ltd",num:"113646",date:"2026-07-04",net:2995.20,acct:"4000",desc:"Gyvlon Eco screed, tickets 157383/157384/157385, Higher Farm"},
 {contact:"Metal Stair co",num:"INV-901",date:"2026-09-11",net:8910.00,acct:"1030",desc:"Carbon steel, clamped glass & oak staircase and 2.4m landing balustrade, ref 26050/50"},
 {contact:"Hopkins concrete",num:"150842",date:"2026-08-31",net:4098.25,acct:"1002",desc:"Sand, skip, Gen1 and C20 concrete, limestone, fuel surcharges - Aug 2026"},
]
const acc=await xeroGet("/api.xro/2.0/Accounts",{headers:{Accept:"application/json"}})
const codes=new Set(((await acc.json()).Accounts??[]).map((a:any)=>a.Code))
for(const d of DOCS){
  const ex=await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${d.num}"`,{headers:{Accept:"application/json"}})
  if(((await ex.json()).Invoices??[]).length){ console.log(`  ${d.num} already in Xero`); continue }
  const g=await xeroGet(`/api.xro/2.0/Contacts?where=Name=="${d.contact}"`,{headers:{Accept:"application/json"}})
  let cid=((await g.json()).Contacts??[])[0]?.ContactID
  if(!cid){
    const c=await xeroFetch("/api.xro/2.0/Contacts",{method:"POST",
      headers:{Accept:"application/json","Content-Type":"application/json"},
      body:JSON.stringify({Contacts:[{Name:d.contact}]})})
    if(!c.ok){ console.log(`  !! contact ${d.contact}: ${(await c.text()).slice(0,120)}`); continue }
    cid=((await c.json()).Contacts??[])[0]?.ContactID; console.log(`  created contact ${d.contact}`)
  }
  const code=codes.has(d.acct)?d.acct:"4000"
  const r=await xeroFetch("/api.xro/2.0/Invoices",{method:"POST",
    headers:{Accept:"application/json","Content-Type":"application/json"},
    body:JSON.stringify({Invoices:[{Type:"ACCPAY",InvoiceNumber:d.num,Contact:{ContactID:cid},
      Date:d.date,DueDate:d.date,Status:"AUTHORISED",LineAmountTypes:"Exclusive",
      LineItems:[{Description:d.desc,Quantity:1,UnitAmount:d.net,AccountCode:code,TaxType:"INPUT2"}]}]})})
  const txt=await r.text()
  if(!r.ok){ console.log(`  !! ${d.num} ${r.status}: ${JSON.stringify(JSON.parse(txt).Elements?.[0]?.ValidationErrors??txt).slice(0,170)}`); continue }
  const now=JSON.parse(txt).Invoices?.[0]
  console.log(`  ${d.num.padEnd(10)} ${d.contact.slice(0,18).padEnd(19)} total ${now?.Total}  VAT ${now?.TotalTax}  ${now?.Status}`)
}
process.exit(0)
