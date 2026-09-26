import { pool } from "../lib/db"
const h = await pool.query(`select last_scanned_to, updated_at from email_harvest_state where id = 1`)
console.log("email_harvest_state:", JSON.stringify(h.rows[0]))
const c = await pool.query(
  `select to_char(max(created_at),'YYYY-MM-DD HH24:MI') last_insert, count(*) total
     from email_invoice_candidates`)
console.log("candidates table:", JSON.stringify(c.rows[0]))
const byday = await pool.query(
  `select to_char(created_at,'YYYY-MM-DD') d, count(*) n from email_invoice_candidates
    group by 1 order by 1 desc limit 8`)
console.log("\nrows added to the queue, by day:")
for (const r of byday.rows) console.log(`  ${r.d}  ${r.n}`)
const t = await pool.query(`select to_regclass('reconciliation_runs') t`)
if (t.rows[0].t) {
  const r = await pool.query(`select * from reconciliation_runs order by started_at desc limit 6`)
  console.log("\nlast reconciliation runs:")
  for (const x of r.rows) console.log(`  ${JSON.stringify(x).slice(0,150)}`)
}
process.exit(0)
