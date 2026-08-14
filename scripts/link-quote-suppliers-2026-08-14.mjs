/**
 * Link quote supplier names to existing supplier rows where the identity is
 * near-certain (2026-08-14):
 *  - "Target Timber Systems Limited" -> supplier "Target Timber Frames"
 *    (the lender's own drawdown record names "Target Timber Systems" as the
 *    direct-pay recipient for the timber frame; same company)
 *  - "Metal Staircase Co" -> supplier "Metal Stair co"
 * Adds supplier_aliases learning and sets quotes.supplier_id. Dry-run default.
 */
import pg from "pg"
const EXECUTE = process.argv.includes("--execute")
const LINKS = [
  { raw: /target timber/i, supplier: "Target Timber Frames" },
  { raw: /metal stair/i, supplier: "Metal Stair co" },
]
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  for (const l of LINKS) {
    const { rows: [s] } = await c.query("SELECT id, name FROM suppliers WHERE name = $1", [l.supplier])
    if (!s) { console.log(`supplier "${l.supplier}" not found — skip`); continue }
    const { rows: qs } = await c.query("SELECT id, supplier_name_raw FROM quotes WHERE supplier_id IS NULL")
    const hits = qs.filter((q) => l.raw.test(q.supplier_name_raw ?? ""))
    console.log(`${l.supplier} (#${s.id}): ${hits.length} quotes match [${hits.map((h) => h.supplier_name_raw).join(", ")}]`)
    if (EXECUTE && hits.length) {
      await c.query("UPDATE quotes SET supplier_id = $1 WHERE id = ANY($2::int[])", [s.id, hits.map((h) => h.id)])
      for (const name of new Set(hits.map((h) => h.supplier_name_raw))) {
        const norm = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(ltd|limited|plc|co|company)\b/g, " ").replace(/\s+/g, " ").trim()
        await c.query(`INSERT INTO supplier_aliases (supplier_id, normalised_name, raw_name)
          SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM supplier_aliases WHERE normalised_name = $2)`, [s.id, norm, name])
      }
    }
  }
  if (EXECUTE) { await c.query("COMMIT"); console.log("COMMITTED") } else { await c.query("ROLLBACK"); console.log("DRY RUN") }
} catch (e) { await c.query("ROLLBACK"); console.error(e.message); process.exit(1) } finally { c.release(); await pool.end() }
