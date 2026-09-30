import { pool } from "../lib/db"
const BATCH: [string,string,number][] = [
  ["78483398","2026-08-04",146.40],["78481976","2026-08-04",117.80],["78494276","2026-08-06",371.52],
  ["78508226","2026-08-10",165.82],["78513175","2026-08-11",8.39],["78518272","2026-08-12",1048.03],
  ["78575574","2026-08-13",458.21],["78565469","2026-08-14",288.01],["78530306","2026-08-14",6.83],
  ["78537916","2026-08-17",33.65],["78537307","2026-08-17",297.38],["78536853","2026-08-17",156.91],
  ["78536200","2026-08-17",177.14],["78547422","2026-08-19",938.52],["78554269","2026-08-20",1108.80],
  ["78568125","2026-08-24",158.52],["78566952","2026-08-24",112.85],["78566797","2026-08-24",255.72],
  ["78565522","2026-08-24",683.62],["78596849","2026-08-28",6190.02],
]
console.log(`batch: ${BATCH.length} invoices, ${BATCH.reduce((s,b)=>s+b[2],0).toFixed(2)}\n`)
const s=await pool.query(`select id from suppliers where lower(name) like '%bradford%' limit 1`)
const sid=s.rows[0].id
const held:string[]=[], missing:[string,string,number][]=[], mismatch:string[]=[]
for(const [num,date,amt] of BATCH){
  const r=await pool.query(`select gross, payment_status from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`,[sid,num])
  if(!r.rows.length){ missing.push([num,date,amt]); continue }
  if(Math.abs(Number(r.rows[0].gross)-amt)>0.02){ mismatch.push(`${num}: OS ${Number(r.rows[0].gross).toFixed(2)} vs statement ${amt.toFixed(2)}`); continue }
  held.push(`${num} ${r.rows[0].payment_status}`)
}
console.log(`IN THE OS, amounts agree: ${held.length}`)
console.log(`  ${held.join("  ")}`)
console.log(`\nNOT IN THE OS: ${missing.length}, ${missing.reduce((s,m)=>s+m[2],0).toFixed(2)}`)
for(const [n,d,a] of missing) console.log(`  ${n}  ${d}  ${a.toFixed(2).padStart(9)}`)
if(mismatch.length){ console.log(`\nAMOUNT MISMATCH — not touched:`); for(const m of mismatch) console.log(`  ${m}`) }
process.exit(0)
