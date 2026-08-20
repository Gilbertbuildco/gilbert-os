/**
 * Owner decision 2026-08-20: an architectural & design category for architect,
 * structural engineer and similar technical fees.
 *
 * Package 24 "Architectural & Design", is_build_cost = true — drawings and
 * structural calculations are part of what it costs to deliver the buildings,
 * unlike legal/broker fees which are the cost of borrowing.
 *
 * Moves the structural engineer's fees in. Deliberately does NOT move Spire
 * Building Control: building control is statutory inspection and approval, not
 * design — it is raised separately for the owner.
 *
 * Idempotent. Dry run by default; --execute to write.
 */
import pg from "pg"

const EXECUTE = process.argv.includes("--execute")
const CODE = "24"
const NAME = "Architectural & Design"
const MOVE_INVOICES = [224, 214] // Structural Solutions — design fee + interim

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  let { rows: [pkg] } = await c.query("SELECT id, code, name, is_build_cost FROM cost_packages WHERE project_id = 1 AND code = $1", [CODE])
  if (pkg) console.log(`package ${CODE} exists (#${pkg.id})`)
  else {
    console.log(`would create package ${CODE} "${NAME}" (is_build_cost = true)`)
    if (EXECUTE) {
      const r = await c.query("INSERT INTO cost_packages (project_id, code, name, is_build_cost) VALUES (1,$1,$2,true) RETURNING id", [CODE, NAME])
      pkg = r.rows[0]; console.log(`  created #${pkg.id}`)
    }
  }
  for (const invId of MOVE_INVOICES) {
    const { rows } = await c.query(`
      SELECT li.id, li.description, li.line_net, li.cost_package_id, s.name supplier, i.supplier_id
        FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id JOIN suppliers s ON s.id=i.supplier_id
       WHERE li.invoice_id = $1`, [invId])
    for (const l of rows) {
      if (pkg && l.cost_package_id === pkg.id) { console.log(`  line ${l.id} already in ${CODE}`); continue }
      console.log(`  move line ${l.id} £${Number(l.line_net).toFixed(2)} ${l.supplier}: pkg ${l.cost_package_id ?? "none"} -> ${CODE}`)
      if (EXECUTE && pkg) {
        await c.query("UPDATE invoice_line_items SET cost_package_id=$1 WHERE id=$2", [pkg.id, l.id])
        const key = String(l.description ?? "").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim()
        if (key) await c.query(`
          INSERT INTO classification_mappings (key_kind,key_value,supplier_id,cost_package_code,cost_package_name,times_confirmed)
          VALUES ('product',$1,$2,$3,$4,1)
          ON CONFLICT (key_kind,key_value,(coalesce(supplier_id,0)))
          DO UPDATE SET cost_package_code=EXCLUDED.cost_package_code, cost_package_name=EXCLUDED.cost_package_name,
                        times_confirmed=classification_mappings.times_confirmed+1, updated_at=now()`,
          [key, l.supplier_id, CODE, NAME])
      }
    }
  }
  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\nDRY RUN — nothing written.") }
  else {
    const { rows: [t] } = await c.query(`SELECT COALESCE(SUM(li.line_net),0) s FROM invoice_line_items li
      JOIN invoices i ON i.id=li.invoice_id WHERE i.status='confirmed' AND li.cost_package_id=$1`, [pkg.id])
    await c.query("COMMIT")
    console.log(`\nCOMMITTED. Package ${CODE} holds £${Number(t.s).toFixed(2)}`)
  }
} catch (e) { await c.query("ROLLBACK"); console.error("Rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
