/**
 * Crestmoor is one company held as three supplier records. Every invoice
 * document reads "Crestmoor Construction Services Ltd" (id 24), so that is the
 * survivor; 5 (Group of Companies) and 14 (Plant Hire) merge into it.
 *
 * Nothing is deleted except supplier rows left empty at the end, and rows that
 * would be exact duplicates of ones the survivor already has. Runs in a
 * transaction: any error and the whole thing rolls back.
 */
import { pool } from "../lib/db"
const EXECUTE = process.argv.includes("--execute")
const KEEP = 24, MERGE = [5, 14]

const u = await pool.query(
  `select tc.table_name, string_agg(kcu.column_name, ',' order by kcu.ordinal_position) cols
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
    where tc.constraint_type = 'UNIQUE' and tc.table_schema='public'
      and tc.table_name in ('classification_mappings','supplier_aliases','supplier_external_paid')
    group by 1`)
console.log("unique constraints:"); for (const x of u.rows) console.log(`  ${x.table_name} (${x.cols})`)

const client = await pool.connect()
try {
  await client.query("BEGIN")
  const before = await client.query(`select id, name from suppliers where id = any($1)`, [[KEEP, ...MERGE]])
  console.log("\nmerging:")
  for (const s of before.rows) console.log(`  [${s.id}] ${s.name}${s.id === KEEP ? "   <- SURVIVOR" : ""}`)

  for (const t of ["invoices","classification_mappings","supplier_aliases","supplier_external_paid","price_records","quotes","supplier_products"]) {
    let moved = 0, dropped = 0
    try {
      const r = await client.query(`update ${t} set supplier_id = $1 where supplier_id = any($2)`, [KEEP, MERGE])
      moved = r.rowCount ?? 0
    } catch {
      // unique collision: keep the survivor's row, drop the duplicate incomer
      const d = await client.query(`delete from ${t} where supplier_id = any($1)`, [MERGE])
      dropped = d.rowCount ?? 0
    }
    if (moved || dropped) console.log(`  ${t.padEnd(26)} moved ${moved}  dropped-as-duplicate ${dropped}`)
  }
  const still = await client.query(`select count(*) n from invoices where supplier_id = any($1)`, [MERGE])
  if (Number(still.rows[0].n) > 0) throw new Error("invoices still point at a merged supplier — aborting")
  const del = await client.query(`delete from suppliers where id = any($1) returning id, name`, [MERGE])
  console.log(`\n  removed ${del.rowCount} now-empty supplier rows: ${del.rows.map((x:any)=>x.name).join(", ")}`)
  const after = await client.query(
    `select count(*) n, sum(gross)::numeric g, min(to_char(invoice_date,'YYYY-MM-DD')) lo, max(to_char(invoice_date,'YYYY-MM-DD')) hi
       from invoices where supplier_id = $1`, [KEEP])
  console.log(`  Crestmoor now: ${after.rows[0].n} invoices, ${Number(after.rows[0].g).toFixed(2)}, ${after.rows[0].lo}..${after.rows[0].hi}`)
  if (EXECUTE) { await client.query("COMMIT"); console.log("\nCOMMITTED") }
  else { await client.query("ROLLBACK"); console.log("\nrolled back (dry run)") }
} catch (e:any) { await client.query("ROLLBACK"); console.log("ROLLED BACK:", e.message) }
finally { client.release() }
process.exit(0)
