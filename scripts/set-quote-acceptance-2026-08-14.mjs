/**
 * Owner correction (2026-08-14): only quotes later ACCEPTED count.
 *  - Castlebrook Plumbing & Heating (3 estimates) -> not_accepted: the
 *    plumbing work went to Marshisaacs per the payments.
 *  - Accepted (supplier subsequently paid for that scope): SSEN FGG947/2
 *    (its £23,134.86 equals the two connection payments to the penny),
 *    Target Timber GMG/MF/25279, Bradfords roofing quotes x3, City Plumbing
 *    bathroom quotes x3, Mayflower current revisions x3.
 *  - Left open pending the owner: Metal Staircase V1 vs V2 (only one was
 *    accepted), Landford alternates, Roofing Gear, Civils Store.
 * Dry-run default; --execute to write.
 */
import pg from "pg"
const EXECUTE = process.argv.includes("--execute")
const SET = [
  { ids: [21, 22, 23], status: "not_accepted", why: "plumbing awarded to Marshisaacs" },
  { ids: [19, 24, 25, 26, 27, 29, 30, 31, 8, 9, 10], status: "accepted", why: "supplier subsequently engaged/paid for this scope" },
]
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  for (const s of SET) {
    const { rows } = await c.query("SELECT id, supplier_name_raw, reference, status FROM quotes WHERE id = ANY($1::int[]) ORDER BY id", [s.ids])
    for (const q of rows) console.log(`#${q.id} ${q.supplier_name_raw} ${q.reference ?? ""}: ${q.status} -> ${s.status} (${s.why})`)
    if (EXECUTE) await c.query("UPDATE quotes SET status = $2, notes = COALESCE(notes || ' | ', '') || $3 WHERE id = ANY($1::int[])", [s.ids, s.status, `Owner rule 2026-08-14: ${s.why}`])
  }
  if (EXECUTE) { await c.query("COMMIT"); console.log("COMMITTED") } else { await c.query("ROLLBACK"); console.log("DRY RUN") }
} catch (e) { await c.query("ROLLBACK"); console.error(e.message); process.exit(1) } finally { c.release(); await pool.end() }
