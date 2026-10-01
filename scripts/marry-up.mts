/**
 * Match unpaid OS invoices against Xero SPEND payments, per supplier.
 * Reports only — writes nothing. Exact single matches are strong evidence; a
 * subset of 2-4 invoices summing to a payment is good; anything needing more
 * than that is noise (proved on Bradfords, where 12 invoices "matched" a round
 * 10,000 by coincidence).
 */
import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const parse=(v:any)=>{const m=/\/Date\((\d+)/.exec(String(v??""));return m?new Date(Number(m[1])).toISOString().slice(0,10):""}
const bt=await xeroGet("/api.xro/2.0/BankTransactions?pageSize=1000",{headers:{Accept:"application/json"}})
const spend=((await bt.json()).BankTransactions??[]).filter((t:any)=>t.Status==="AUTHORISED"&&t.Type==="SPEND")
const inv=await pool.query(
  `select i.id, s.name sup, i.invoice_number num, to_char(i.invoice_date,'YYYY-MM-DD') d,
          (i.gross-coalesce(i.amount_paid,0))::numeric owed
     from invoices i join suppliers s on s.id=i.supplier_id
    where i.transaction_type='invoice' and coalesce(i.payment_status,'unpaid')<>'paid'
      and (i.gross-coalesce(i.amount_paid,0)) > 0
    order by s.name, i.invoice_date`)
const first=(s:string)=>String(s??"").toLowerCase().replace(/[^a-z ]/g,"").split(" ").filter(Boolean)[0]??""
const bySup: Record<string, any[]> = {}
for(const r of inv.rows){ (bySup[first(r.sup)] ??= []).push(r) }
const p=(n:number)=>Math.round(n*100)

let strong=0
for(const [key, rows] of Object.entries(bySup)){
  const pays=spend.filter((t:any)=>first(t.Contact?.Name).startsWith(key.slice(0,6))||key.startsWith(first(t.Contact?.Name).slice(0,6)))
  if(!pays.length) continue
  console.log(`\n### ${rows[0].sup}  — ${rows.length} unpaid (${rows.reduce((s:number,r:any)=>s+Number(r.owed),0).toFixed(2)}), ${pays.length} payments (${pays.reduce((s:number,t:any)=>s+t.Total,0).toFixed(2)})`)
  const used=new Set<number>()
  for(const t of pays.sort((a:any,b:any)=>parse(a.Date).localeCompare(parse(b.Date)))){
    const target=p(t.Total)
    const ex=rows.find((r:any)=>!used.has(r.id)&&p(Number(r.owed))===target)
    if(ex){ used.add(ex.id); strong++
      console.log(`  ${parse(t.Date)} ${String(t.Total).padStart(10)}  == ${ex.num} (${ex.d})   EXACT`); continue }
    // subset of up to 4
    const pool_=rows.filter((r:any)=>!used.has(r.id)&&r.d<=parse(t.Date))
    let found:any[]|null=null
    const rec=(i:number,rem:number,acc:any[]):any[]|null=>{
      if(rem===0&&acc.length>1) return acc
      if(i>=pool_.length||rem<0||acc.length>=4) return null
      const take=rec(i+1,rem-p(Number(pool_[i].owed)),[...acc,pool_[i]])
      return take ?? rec(i+1,rem,acc)
    }
    found=rec(0,target,[])
    if(found){ found.forEach((r:any)=>used.add(r.id)); strong++
      console.log(`  ${parse(t.Date)} ${String(t.Total).padStart(10)}  == ${found.map((r:any)=>r.num).join(" + ")}   COMBINATION`) }
    else console.log(`  ${parse(t.Date)} ${String(t.Total).padStart(10)}  -- no combination of up to 4 unpaid invoices`)
  }
}
console.log(`\nconfident matches: ${strong}`)
process.exit(0)
