/** For each supplier payment sitting in the Xero reconcile queue, is there a
 *  bill to match it to? Where there is not, the invoice was never captured. */
import { xeroGet } from "../lib/xero/client"
import { pool } from "../lib/db"
const QUEUE: [string,string,number][] = [
  ["2026-07-15","GOLDEN TREE FINANCE",600.00],["2026-07-29","PROTEK GROUP",95.00],
  ["2026-08-03","METAL STAIRS",5911.21],["2026-08-05","THOMAS L GILBERT",553.10],
  ["2026-08-05","THOMAS L GILBERT",9147.00],["2026-08-10","SCOPE",4447.20],
  ["2026-08-12","S MORRIS",864.72],["2026-08-12","MAYFLOWER KBB",3832.50],
  ["2026-08-20","MAYFLOWER KBB",4070.86],["2026-08-20","MAYFLOWER KBB",4517.00],
  ["2026-08-20","MAYFLOWER KBB",6158.50],["2026-08-20","MAYFLOWER KBB",1123.66],
  ["2026-09-02","AMERICAN EXPRESS",14558.25],["2026-09-02","ANDREW HOPKINS",2691.90],
  ["2026-09-07","BATTENS SOLICITORS",100.00],["2026-09-10","SCREWFIX",18.99],
  ["2026-09-17","MARSHALLS METAL",1710.00],["2026-09-18","METAL STAIRS",9012.00],
  ["2026-09-21","MAYFLOWER KBB",4831.58],["2026-09-29","MAYFLOWER KBB",12797.49],
  ["2026-09-30","RHYS HARVEY",4870.00],["2026-09-30","ROSEAL",327.50],
  ["2026-09-30","CARRARINO",1506.00],["2026-09-01","A & R TILES",75.60],
]
const bills:any[]=[]
for(let p=1;;p++){const r=await xeroGet(`/api.xro/2.0/Invoices?where=Type=="ACCPAY"&page=${p}&pageSize=100`,{headers:{Accept:"application/json"}})
  const inv=(await r.json()).Invoices??[]; bills.push(...inv); if(inv.length<100)break}
const open=bills.filter(b=>b.Status==="AUTHORISED")
const key=(s:string)=>String(s).toLowerCase().replace(/[^a-z]/g,"").slice(0,6)
let matchable=0, noBill=0, mTot=0, nTot=0
console.log("payment                                      outstanding bills for that supplier")
for(const [d,who,amt] of QUEUE){
  const k=key(who)
  const theirs=open.filter(b=>key(b.Contact?.Name??"").startsWith(k.slice(0,5))||k.startsWith(key(b.Contact?.Name??"").slice(0,5)))
  const due=theirs.reduce((s,b)=>s+(b.AmountDue??0),0)
  const osHas=await pool.query(
    `select count(*) n, coalesce(sum(i.gross),0)::numeric g from invoices i join suppliers s on s.id=i.supplier_id
      where lower(s.name) like '%'||$1||'%'`,[k.slice(0,5)])
  const verdict = theirs.length ? `${theirs.length} bills, ${due.toFixed(2)} due` : `NO BILL — OS holds ${osHas.rows[0].n} invoices (${Number(osHas.rows[0].g).toFixed(2)})`
  if(theirs.length){matchable++; mTot+=amt} else {noBill++; nTot+=amt}
  console.log(`  ${d}  ${who.slice(0,20).padEnd(21)} ${amt.toFixed(2).padStart(10)}   ${verdict}`)
}
console.log(`\n  matchable to a bill : ${matchable} payments, ${mTot.toFixed(2)}`)
console.log(`  NO bill to match    : ${noBill} payments, ${nTot.toFixed(2)}  <- invoice never captured, or already settled`)
process.exit(0)
