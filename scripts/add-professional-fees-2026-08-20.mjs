/**
 * Owner decision 2026-08-20: George Wilson is a freelance site foreman and his
 * invoices are professional fees, not preliminaries.
 *
 * Package 27 "Professional Fees", is_build_cost = true — site management is
 * part of delivering the buildings (consistent with Architectural & Design),
 * unlike legal/broker fees or the van which are excluded.
 *
 * Moves all seven George Wilson lines out of Preliminaries. One of them, SM01
 * £20,000, is described on the invoice as "Building works" rather than project
 * management — moved as instructed, but a question is attached so the owner can
 * split it back out if that £20,000 was construction rather than a fee.
 *
 * Idempotent. Dry run by default; --execute to write.
 */
import pg from "pg"

const EXECUTE = process.argv.includes("--execute")
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  let { rows: [pkg] } = await c.query("SELECT id FROM cost_packages WHERE project_id=1 AND code='27'")
  if (pkg) console.log("package 27 exists")
  else {
    console.log('would create package 27 "Professional Fees" (is_build_cost = true)')
    if (EXECUTE) {
      pkg = (await c.query("INSERT INTO cost_packages (project_id,code,name,is_build_cost) VALUES (1,'27','Professional Fees',true) RETURNING id")).rows[0]
      console.log(`  created #${pkg.id}`)
    }
  }
  const { rows } = await c.query(`SELECT li.id, li.line_net, li.cost_package_id, li.description, i.id inv, i.invoice_number, i.supplier_id
    FROM invoice_line_items li JOIN invoices i ON i.id=li.invoice_id JOIN suppliers s ON s.id=i.supplier_id
    WHERE s.name ILIKE '%george wilson%' AND i.status='confirmed' ORDER BY i.invoice_date`)
  let moved = 0
  for (const l of rows) {
    if (pkg && l.cost_package_id === pkg.id) { console.log(`  line ${l.id} already in 27`); continue }
    console.log(`  move line ${l.id} ${l.invoice_number} £${Number(l.line_net).toFixed(2)} -> 27`)
    if (EXECUTE && pkg) {
      await c.query("UPDATE invoice_line_items SET cost_package_id=$1 WHERE id=$2", [pkg.id, l.id])
      moved++
      const key = String(l.description ?? "").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim()
      if (key) await c.query(`
        INSERT INTO classification_mappings (key_kind,key_value,supplier_id,cost_package_code,cost_package_name,times_confirmed)
        VALUES ('product',$1,$2,'27','Professional Fees',1)
        ON CONFLICT (key_kind,key_value,(coalesce(supplier_id,0)))
        DO UPDATE SET cost_package_code='27', cost_package_name='Professional Fees',
                      times_confirmed=classification_mappings.times_confirmed+1, updated_at=now()`,
        [key, l.supplier_id])
      if (l.invoice_number === "SM01") {
        await c.query("UPDATE invoices SET review_question=$2, review_question_at=now() WHERE id=$1",
          [l.inv, "SM01 (£20,000) is described on the invoice as 'Building works' rather than project management, unlike SM02-SM07 which are all £6,000 monthly fees. It has been moved to Professional Fees with the rest — but if that £20,000 was actual construction work it belongs in a trade package instead. Which is it?"])
      }
    }
  }
  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\nDRY RUN — nothing written.") }
  else {
    const { rows: [t] } = await c.query(`SELECT COALESCE(SUM(li.line_net),0) s FROM invoice_line_items li
      JOIN invoices i ON i.id=li.invoice_id JOIN cost_packages cp ON cp.id=li.cost_package_id
      WHERE i.status='confirmed' AND cp.code='01' AND cp.project_id=1`)
    const { rows: [pf] } = await c.query(`SELECT COALESCE(SUM(li.line_net),0) s FROM invoice_line_items li
      JOIN invoices i ON i.id=li.invoice_id WHERE i.status='confirmed' AND li.cost_package_id=$1`, [pkg.id])
    await c.query("COMMIT")
    console.log(`\nCOMMITTED. Moved ${moved}. Professional Fees £${Number(pf.s).toFixed(2)} | Preliminaries now £${Number(t.s).toFixed(2)}`)
  }
} catch (e) { await c.query("ROLLBACK"); console.error("Rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
