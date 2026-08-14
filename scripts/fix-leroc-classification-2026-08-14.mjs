/**
 * Owner-surfaced correction 2026-08-14: the Le Roc bill line "Block and Beam
 * upfront payment" (£13,371 net) was classified to 04 External Walls on a
 * supplier-trade assumption; the document says block & beam — package 02
 * Groundworks & Foundations. Updates the line and the learned mapping.
 * Dry-run default; --execute to write.
 */
import pg from "pg"
const EXECUTE = process.argv.includes("--execute")
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const { rows } = await c.query(`
    SELECT li.id, li.line_net, li.cost_package_id, i.supplier_id FROM invoice_line_items li
    JOIN invoices i ON i.id = li.invoice_id JOIN suppliers s ON s.id = i.supplier_id
    WHERE s.name = 'Le Roc' AND li.description ILIKE '%block and beam%'`)
  if (rows.length !== 1) throw new Error(`expected 1 Le Roc block-and-beam line, found ${rows.length}`)
  const l = rows[0]
  const { rows: [pkg] } = await c.query("SELECT id, code, name FROM cost_packages WHERE project_id = 1 AND code = '02'")
  console.log(`line ${l.id} £${l.line_net}: package ${l.cost_package_id} -> ${pkg.id} (${pkg.code} ${pkg.name})`)
  if (EXECUTE) {
    await c.query("UPDATE invoice_line_items SET cost_package_id = $1 WHERE id = $2", [pkg.id, l.id])
    await c.query(`
      UPDATE classification_mappings SET cost_package_code = '02', cost_package_name = $2, updated_at = now()
      WHERE key_kind = 'product' AND supplier_id = $1 AND key_value ILIKE '%block and beam%'`, [l.supplier_id, pkg.name])
    await c.query("COMMIT")
    console.log("COMMITTED")
  } else { await c.query("ROLLBACK"); console.log("DRY RUN — nothing written") }
} catch (e) { await c.query("ROLLBACK"); console.error("Rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
