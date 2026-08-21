/**
 * `email_invoice_candidates` — a durable record of every invoice-looking email
 * the daily job has ever seen, and what happened to it.
 *
 * Why this exists (owner, 2026-08-21): "If you see an invoice and it relates to
 * building you have to at least ask me about it."
 *
 * The daily harvest held no state. Each run rebuilt its candidate list from
 * scratch, so anything found but not processed in that same run was silently
 * lost — on 2026-08-21 a £5,200 sewage treatment plant invoice was listed in
 * the run's own output and then dropped when attention moved elsewhere. A row
 * here survives the run that created it, so "seen" and "dealt with" stop being
 * the same thing.
 *
 * STATUS
 *   found        recorded from the mailbox, nothing done yet
 *   saved        attachment written to disk
 *   ingested     committed to Gilbert OS (invoice_id set)
 *   pushed       bill created in Xero
 *   needs_owner  building-related but cannot be processed automatically —
 *                MUST be surfaced to the owner, never quietly closed
 *   not_invoice  reviewed and judged not an invoice (reason recorded)
 *
 * Nothing is ever deleted. A run is only complete when no row is left in
 * 'found' or 'saved'.
 *
 * Idempotent: safe to re-run.
 */
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  await c.query(`
    CREATE TABLE IF NOT EXISTS email_invoice_candidates (
      id             serial PRIMARY KEY,
      message_key    text NOT NULL,
      received_at    timestamptz,
      sender         text,
      subject        text,
      attachments    text,
      status         text NOT NULL DEFAULT 'found',
      reason         text,
      saved_path     text,
      invoice_id     integer,
      first_seen_at  timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    )`)
  // One row per email. Re-scanning the same window must update, never duplicate.
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS email_invoice_candidates_key_uidx ON email_invoice_candidates (message_key)`)
  await c.query(`CREATE INDEX IF NOT EXISTS email_invoice_candidates_status_idx ON email_invoice_candidates (status)`)
  // High-water mark, so a gap between runs can never be skipped.
  await c.query(`
    CREATE TABLE IF NOT EXISTS email_harvest_state (
      id              integer PRIMARY KEY DEFAULT 1,
      last_scanned_to timestamptz,
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT email_harvest_state_single_row CHECK (id = 1)
    )`)
  await c.query(`INSERT INTO email_harvest_state (id, last_scanned_to) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING`)
  const { rows } = await c.query(`SELECT count(*)::int n FROM email_invoice_candidates`)
  console.log(`email_invoice_candidates ready (${rows[0].n} rows); email_harvest_state ready`)
  await c.query("COMMIT")
  console.log("COMMITTED")
} catch (e) { await c.query("ROLLBACK"); console.error("rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
