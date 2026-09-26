import { pool } from "../lib/db"
const r = await pool.query(
  `select table_name, column_name from information_schema.columns
    where column_name like '%supplier%' and table_schema='public' order by 1`)
console.log("columns referencing a supplier:")
for (const x of r.rows) console.log(`  ${x.table_name}.${x.column_name}`)
console.log("\nrow counts against the three Crestmoor ids (5, 14, 24):")
for (const x of r.rows) {
  if (!/_id$/.test(x.column_name)) continue
  try {
    const c = await pool.query(`select ${x.column_name} sid, count(*) n from ${x.table_name} where ${x.column_name} = any($1) group by 1 order by 1`, [[5,14,24]])
    if (c.rows.length) console.log(`  ${x.table_name}: ${c.rows.map((y:any)=>`id${y.sid}=${y.n}`).join(", ")}`)
  } catch (e:any) { console.log(`  ${x.table_name}: (${String(e.message).slice(0,40)})`) }
}
process.exit(0)
