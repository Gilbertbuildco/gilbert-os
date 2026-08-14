/**
 * Owner answers, round 2 (2026-08-14):
 *  - Metal Staircase: V1 (£15,160, quote #16) ACCEPTED. V2 (#17) not accepted
 *    as a whole, but the owner notes some extras on that list were accepted —
 *    amounts not yet specified, so V2 carries a note and counts nothing.
 *  - Roofing Gear (#20) and Civils Store (#28): not accepted.
 *  - Landford (#1-7): owner says ignore for now — left open, counts nothing.
 * Dry-run default; --execute to write.
 */
import pg from "pg"
const EXECUTE = process.argv.includes("--execute")
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const plan = [
    { id: 16, status: "accepted", note: "Owner 2026-08-14: V1 accepted at GBP 15,160." },
    { id: 17, status: "not_accepted", note: "Owner 2026-08-14: V2 not accepted as a whole, but some extras on this list WERE accepted - amounts pending owner detail; counts nothing until specified." },
    { id: 20, status: "not_accepted", note: "Owner 2026-08-14: not accepted." },
    { id: 28, status: "not_accepted", note: "Owner 2026-08-14: not accepted." },
  ]
  for (const p of plan) {
    const { rows: [q] } = await c.query("SELECT supplier_name_raw, reference, status FROM quotes WHERE id = $1", [p.id])
    console.log(`#${p.id} ${q.supplier_name_raw} ${q.reference ?? ""}: ${q.status} -> ${p.status}`)
    if (EXECUTE) await c.query("UPDATE quotes SET status = $2, notes = COALESCE(notes || ' | ', '') || $3 WHERE id = $1", [p.id, p.status, p.note])
  }
  if (EXECUTE) { await c.query("COMMIT"); console.log("COMMITTED") } else { await c.query("ROLLBACK"); console.log("DRY RUN") }
} catch (e) { await c.query("ROLLBACK"); console.error(e.message); process.exit(1) } finally { c.release(); await pool.end() }
