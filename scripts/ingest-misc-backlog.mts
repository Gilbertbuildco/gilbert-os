/**
 * Remainder of the email backlog. All figures read VERBATIM off the documents.
 * Porcelanosa print European decimals (136,40 = £136.40) - converted, not guessed.
 *
 * Rhys Harvey INV-0563 is DOMESTIC REVERSE CHARGE: he charges no VAT and Gilbert
 * Build accounts for £974.00 output tax to HMRC and reclaims it. Stored vat 0.00
 * because that is what the invoice charges; the DRC obligation is in the note.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
type R = { sup: string; num: string; date: string; net: number; vat: number; gross: number; note: string }
const ROWS: R[] = [
  { sup: "porcelanosa", num: "6626107526", date: "2026-08-28", net: 136.40, vat: 27.28, gross: 163.68,
    note: "Saddle Caliza 45x120, 3.240 SQM. Tax base 136,40 / VAT charge 27,28 / total 163,68 as printed." },
  { sup: "porcelanosa", num: "6626108220", date: "2026-09-22", net: 449.75, vat: 89.95, gross: 539.70,
    note: "UK stock transfer, Mediterranea Calpe Warmgrey, Capri Bone. Tax base 449,75 / VAT 89,95 / total 539,70 as printed." },
  { sup: "rhys", num: "INV-0547", date: "2026-08-14", net: 1220.00, vat: 244.00, gross: 1464.00,
    note: "Materials 320.00 + labour 900.00, both charged at 20%. QUERY: new-build construction services should be zero-rated - he zero-rated INV-0534 and reverse-charged INV-0563, so three treatments on one site." },
  { sup: "rhys", num: "INV-0563", date: "2026-09-22", net: 4870.00, vat: 0.00, gross: 4870.00,
    note: "Materials 2,720.00 + labour 2,150.00. DOMESTIC REVERSE CHARGE: no VAT charged; Gilbert Build must account for 974.00 output VAT to HMRC and reclaim it. Note DRC does not apply to zero-rated new-build supplies - confirm the correct treatment." },
  { sup: "wilson", num: "SM08", date: "2026-08-31", net: 6000.00, vat: 0.00, gross: 6000.00,
    note: "George Wilson freelance project management, works 1/8/2026-31/8/2026. Matches the SM02-SM07 monthly pattern exactly." },
]
for (const r of ROWS)
  if (Math.abs(r.net + r.vat - r.gross) > 0.005) { console.log(`REFUSING ${r.num}: does not add up`); process.exit(1) }
const p = await pool.query(`select id from projects order by id limit 1`)
const projectId = p.rows[0].id
let add = 0, skip = 0
for (const r of ROWS) {
  const s = await pool.query(`select id, name from suppliers where lower(name) like '%' || $1 || '%'`, [r.sup])
  if (s.rows.length !== 1) { console.log(`  ${r.num}: supplier '${r.sup}' matched ${s.rows.length} - SKIPPED`, s.rows.map((x:any)=>x.name)); continue }
  const supplierId = s.rows[0].id
  const ex = await pool.query(`select id from invoices where supplier_id=$1 and invoice_number=$2 and transaction_type='invoice'`, [supplierId, r.num])
  if (ex.rows.length) { skip++; console.log(`  skip ${r.num} (already present)`); continue }
  add++
  if (!EXECUTE) { console.log(`  would add ${s.rows[0].name} ${r.num} ${r.date} net ${r.net} vat ${r.vat} gross ${r.gross}`); continue }
  await pool.query(
    `insert into invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
       net, vat, gross, status, notes, payment_status, needs_review, confidence)
     values ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,'unpaid',$9,1) on conflict do nothing`,
    [supplierId, projectId, r.num, r.date, r.net, r.vat, r.gross, r.note, /reverse charge|QUERY/i.test(r.note)])
  console.log(`  added ${s.rows[0].name.padEnd(22)} ${r.num.padEnd(12)} ${r.date}  ${r.gross.toFixed(2)}`)
}
console.log(`\n${EXECUTE ? "added" : "would add"} ${add}, already present ${skip}`)
process.exit(0)
