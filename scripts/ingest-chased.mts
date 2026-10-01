/**
 * Three invoices the reconcile queue proved were missing - payments existed with
 * no bill to match. Found in email, figures verbatim.
 *   S Morris 113646   04/07/26  2,995.20 + 599.04  = 3,594.24
 *   Metal Stairs INV-901 11/09/26  8,910.00 + 1,782.00 = 10,692.00
 *   Hopkins 150842    31/08/26  gross 4,917.90 from their own statement;
 *                               net/VAT derived at 20% (every line standard-rated)
 */
import { pool } from "../lib/db"
const EXECUTE=process.argv.includes("--execute")
type R={sup:string;newSup?:[string,string,string];num:string;date:string;net:number;vat:number;gross:number;note:string}
const ROWS:R[]=[
 {sup:"morris",newSup:["S. Morris Ltd","Tout Quarry, Charlton Adam, Somerton TA11 7AN","Ready mixed concrete, screed, sand, aggregates, blocks and bricks."],
  num:"113646",date:"2026-07-04",net:2995.20,vat:599.04,gross:3594.24,
  note:"Gyvlon Eco Gyvlon 260 screed, tickets 157383/157384/157385, delivered Higher Farm. Found chasing a payment with no bill."},
 {sup:"metal stair",num:"INV-901",date:"2026-09-11",net:8910.00,vat:1782.00,gross:10692.00,
  note:"Carbon steel, clamped glass & oak staircase 7,430.00 + 2.4m landing balustrade 780.00 + social media discount line 700.00. Ref 26050/50. Found chasing a payment with no bill."},
 {sup:"hopkins",num:"150842",date:"2026-08-31",net:4098.25,vat:819.65,gross:4917.90,
  note:"Building sand, skip, Gen1 and C20 concrete, limestone, fuel surcharges, Aug 2026. Gross 4,917.90 is stated on Andrew Hopkins' own statement to 31/08/2026; net and VAT derived at 20% as every line is standard-rated. Found chasing a payment with no bill."},
]
for(const r of ROWS) if(Math.abs(r.net+r.vat-r.gross)>0.02){ console.log(`REFUSING ${r.num}`); process.exit(1) }
const p=await pool.query(`select id from projects order by id limit 1`)
for(const r of ROWS){
  let s=await pool.query(`select id,name from suppliers where lower(name) like '%'||$1||'%'`,[r.sup])
  if(!s.rows.length&&r.newSup){
    if(!EXECUTE){ console.log(`  would create ${r.newSup[0]}`); continue }
    s=await pool.query(`insert into suppliers (name,contact,notes) values ($1,$2,$3) returning id,name`,r.newSup)
    console.log(`  created supplier ${r.newSup[0]}`)
  }
  if(s.rows.length!==1){ console.log(`  ${r.num}: supplier matched ${s.rows.length}`,s.rows.map((x:any)=>x.name)); continue }
  const ex=await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`,[s.rows[0].id,r.num])
  if(ex.rows.length){ console.log(`  skip ${r.num}`); continue }
  if(!EXECUTE){ console.log(`  would add ${s.rows[0].name} ${r.num} ${r.gross.toFixed(2)}`); continue }
  await pool.query(
    `insert into invoices (supplier_id,project_id,invoice_number,invoice_date,transaction_type,
       net,vat,gross,status,notes,payment_status,needs_review,confidence)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,'unpaid',$9,1) on conflict do nothing`,
    [s.rows[0].id,p.rows[0].id,r.num,r.date,r.net,r.vat,r.gross,r.note,r.num==="150842"])
  console.log(`  added ${String(s.rows[0].name).slice(0,18).padEnd(19)} ${r.num.padEnd(10)} ${r.date}  ${r.gross.toFixed(2).padStart(10)}  VAT ${r.vat.toFixed(2).padStart(8)}`)
}
const t=await pool.query(`select count(*) n, sum(vat)::numeric v from invoices where created_at::date=current_date`)
console.log(`\ningested today: ${t.rows[0].n}, VAT on them ${Number(t.rows[0].v??0).toFixed(2)}`)
process.exit(0)
