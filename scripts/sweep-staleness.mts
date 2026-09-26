/** Prints whole days since the email sweep last SUCCEEDED, or 999 if unknown. */
import { pool } from "../lib/db"
try {
  const r = await pool.query(
    `select extract(epoch from (now() - last_scanned_to))/86400 d from email_harvest_state where id = 1`)
  const d = Number(r.rows[0]?.d)
  console.log(Number.isFinite(d) ? Math.floor(d) : 999)
} catch { console.log(999) }
process.exit(0)
