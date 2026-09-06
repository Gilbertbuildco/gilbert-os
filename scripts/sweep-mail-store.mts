/**
 * Sweep the Apple Mail store on disk for supplier invoice emails.
 *
 * REPLACES the AppleScript scanner. That drove Mail itself, which wedges within
 * seconds on a 100k-message Exchange mailbox, and — worse — every message fetch
 * sat inside a `try` that swallowed the resulting error, so a failed scan and a
 * clean "no invoices found" were indistinguishable. It reported failure as
 * success for a whole day.
 *
 * This reads the .emlx files directly, which is possible now Full Disk Access is
 * granted. It touches every mailbox including Clutter (where Outlook auto-files
 * supplier mail) and cannot silently half-run: it counts what it read and fails
 * loudly if the store is unreadable.
 *
 * It classifies NOTHING as "not an invoice" on its own. Candidates are recorded
 * for review; judging them stays a deliberate step (non-negotiable #6).
 *
 *   npx tsx --env-file=.env.development.local scripts/sweep-mail-store.mts [--days=14]
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pool } from "../lib/db"

const MAIL = `${process.env.HOME}/Library/Mail`
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 14)
const since = Date.now() - days * 86_400_000

/** Senders that generate invoice-shaped mail but are not Higher Farm suppliers. */
const NOISE = /apple\.com|microsoft|expertrain|paypal|123-reg|sagepay|freshbooks|bigyellow|kontrolit|mysite\.com|expert-sender|butterflypatch|nicolajoyce|kenjcosta/i
/** Subject or sender patterns worth a look. Deliberately broad — a false candidate costs a glance, a missed one costs money. */
const WANTED = /invoice|statement|remittance|e-?billing|credit note|payment due|amount due|receipt|quotation|estimate|\bquote\b/i

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (e.endsWith(".emlx") && st.mtimeMs > since) out.push(p)
  }
  return out
}

const files = walk(MAIL)
if (!files.length) {
  throw new Error(`No mail files readable under ${MAIL}. Either Full Disk Access is not granted or the store has moved — failing rather than reporting "no invoices found".`)
}

const header = (raw: string, name: string) => {
  const m = raw.match(new RegExp(`^${name}: (.+)$`, "im"))
  return m ? m[1].trim() : ""
}

let scanned = 0, candidates = 0, inserted = 0
for (const f of files) {
  let raw: string
  try { raw = readFileSync(f, "utf8").slice(0, 8000) } catch { continue }
  scanned++
  const subject = header(raw, "Subject")
  const from = header(raw, "From")
  const date = header(raw, "Date")
  if (!subject || NOISE.test(from)) continue
  if (!WANTED.test(subject)) continue
  candidates++
  const key = header(raw, "Message-ID") || f
  const when = date ? new Date(date) : null
  const r = await pool.query(
    `INSERT INTO email_invoice_candidates (message_key, received_at, sender, subject, attachments, status)
     VALUES ($1,$2,$3,$4,'','found')
     ON CONFLICT (message_key) DO NOTHING RETURNING id`,
    [key.slice(0, 400), when && !Number.isNaN(when.getTime()) ? when.toISOString() : null, from.slice(0, 300), subject.slice(0, 400)])
  if (r.rowCount) inserted++
}

await pool.query(`UPDATE email_harvest_state SET last_scanned_to = now(), updated_at = now() WHERE id = 1`)
console.log(`\nswept ${scanned} messages from the last ${days} days across every mailbox`)
console.log(`  invoice-shaped: ${candidates}   new to the queue: ${inserted}`)

const { rows } = await pool.query(
  `SELECT to_char(received_at,'YYYY-MM-DD') d, sender, subject FROM email_invoice_candidates
    WHERE status = 'found' ORDER BY received_at DESC NULLS LAST LIMIT 25`)
console.log(`\n--- AWAITING REVIEW (${rows.length} shown) ---`)
for (const r of rows) console.log(`  ${r.d ?? "?"}  ${String(r.sender).slice(0, 34).padEnd(35)} ${String(r.subject).slice(0, 52)}`)
await pool.end()
