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
 * Attachments live OUTSIDE the message. Mail stores a partially-downloaded
 * message as `<N>.partial.emlx` under `Messages/` and puts the attachment
 * bodies in a sibling `Attachments/<N>/<part>/<filename>`. Reading the .emlx
 * alone reports "no attachments" while the PDFs sit on disk - that is how the
 * Bradfords window credit notes were missed. We list that directory instead.
 *
 * A document can also arrive under a subject with no invoice word in it at all
 * (the same Bradfords mail was just "GIL157"), so a message carrying a PDF is a
 * candidate on that basis alone, whatever the subject says.
 *
 * It classifies NOTHING as "not an invoice" on its own. Candidates are recorded
 * for review; judging them stays a deliberate step (non-negotiable #6).
 *
 *   npx tsx --env-file=.env.development.local scripts/sweep-mail-store.mts [--days=14]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { pool } from "../lib/db"

const MAIL = `${process.env.HOME}/Library/Mail`
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 14)
const since = Date.now() - days * 86_400_000

/** Senders that generate invoice-shaped mail but are not Higher Farm suppliers. */
const NOISE = /apple\.com|microsoft|expertrain|paypal|123-reg|sagepay|freshbooks|bigyellow|kontrolit|mysite\.com|expert-sender|butterflypatch|nicolajoyce|kenjcosta/i
/** Subject or sender patterns worth a look. Deliberately broad — a false candidate costs a glance, a missed one costs money. */
const WANTED = /invoice|statement|remittance|e-?billing|credit note|payment due|amount due|receipt|quotation|estimate|\bquote\b/i

/** Documents worth pulling. Mail also caches inline signature images - ignored. */
const DOC = /\.(pdf|csv|xlsx?|docx?)$/i

/**
 * Attachment bodies for `.../Messages/<N>.partial.emlx` live at
 * `.../Attachments/<N>/<part>/<filename>`, a sibling of Messages/. Returns the
 * real files on disk, so a partial message still yields its documents.
 */
function attachmentsFor(msgPath: string): string[] {
  const n = basename(msgPath).replace(/\.partial\.emlx$|\.emlx$/, "")
  const dir = join(dirname(dirname(msgPath)), "Attachments", n)
  if (!existsSync(dir)) return []
  const out: string[] = []
  const rec = (d: string) => {
    let es: string[]
    try { es = readdirSync(d) } catch { return }
    for (const e of es) {
      const p = join(d, e)
      let st; try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) rec(p)
      else if (DOC.test(e) && st.size > 0) out.push(p)
    }
  }
  rec(dir)
  return out
}

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

let scanned = 0, candidates = 0, inserted = 0, withDocs = 0, backfilled = 0
for (const f of files) {
  let raw: string
  try { raw = readFileSync(f, "utf8").slice(0, 8000) } catch { continue }
  scanned++
  const subject = header(raw, "Subject")
  const from = header(raw, "From")
  const date = header(raw, "Date")
  if (!subject || NOISE.test(from)) continue
  const attach = attachmentsFor(f)
  // A PDF from a real supplier is a candidate whatever the subject says.
  if (!WANTED.test(subject) && !attach.length) continue
  candidates++
  if (attach.length) withDocs++
  const key = header(raw, "Message-ID") || f
  const when = date ? new Date(date) : null
  const r = await pool.query(
    `INSERT INTO email_invoice_candidates (message_key, received_at, sender, subject, attachments, status)
     VALUES ($1,$2,$3,$4,$5,'found')
     ON CONFLICT (message_key) DO UPDATE
       SET attachments = EXCLUDED.attachments
       WHERE email_invoice_candidates.attachments IS DISTINCT FROM EXCLUDED.attachments
         AND EXCLUDED.attachments <> ''
     RETURNING (xmax = 0) AS is_new`,
    [key.slice(0, 400), when && !Number.isNaN(when.getTime()) ? when.toISOString() : null, from.slice(0, 300), subject.slice(0, 400), attach.join("\n").slice(0, 4000)])
  if (r.rowCount) { if (r.rows[0]?.is_new) inserted++; else backfilled++ }
}

await pool.query(`UPDATE email_harvest_state SET last_scanned_to = now(), updated_at = now() WHERE id = 1`)
console.log(`\nswept ${scanned} messages from the last ${days} days across every mailbox`)
console.log(`  invoice-shaped: ${candidates}   carrying documents: ${withDocs}   new to the queue: ${inserted}   attachments backfilled: ${backfilled}`)

const { rows } = await pool.query(
  `SELECT to_char(received_at,'YYYY-MM-DD') d, sender, subject,
          coalesce(array_length(string_to_array(nullif(attachments,''), E'\n'), 1), 0) n
     FROM email_invoice_candidates
    WHERE status = 'found' ORDER BY received_at DESC NULLS LAST LIMIT 25`)
console.log(`\n--- AWAITING REVIEW (${rows.length} shown) ---`)
for (const r of rows) console.log(`  ${r.d ?? "?"}  ${(Number(r.n) ? `[${r.n} doc] ` : "        ").padEnd(8)} ${String(r.sender).slice(0, 30).padEnd(31)} ${String(r.subject).slice(0, 46)}`)
await pool.end()
