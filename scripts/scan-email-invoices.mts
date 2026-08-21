/**
 * Scan Apple Mail for invoice-looking emails and record EVERY candidate in
 * `email_invoice_candidates` before anything else happens.
 *
 * Owner instruction 2026-08-21: "If you see an invoice and it relates to
 * building you have to at least ask me about it."
 *
 * WHAT CHANGED AND WHY
 *   The previous harvest filtered on subject keywords ("invoice", "statement")
 *   while it scanned, and kept its candidate list only in memory. Two failure
 *   modes followed, both of which actually happened:
 *     1. A supplier whose subject line says something else is invisible. The
 *        Waste Water Supplies email subject was "Vat Invoice" — it matched —
 *        but "Install Guide" (also carrying a real invoice) did not, and
 *        Bradfords bundles four invoices behind one subject line.
 *     2. Anything found but not processed in the same run was lost when the
 *        run ended. A £5,200 sewage treatment plant invoice was printed in a
 *        run's own output and then dropped.
 *
 *   So: detection is now attachment-led rather than subject-led (any message
 *   carrying a document type an invoice arrives as is a candidate), every
 *   candidate is persisted the moment it is seen, and the high-water mark only
 *   advances after a complete pass.
 *
 * This script NEVER decides an email is not an invoice. It records candidates.
 * Judging them is a separate, deliberate step that must end with every row out
 * of 'found'/'saved' — either ingested, or marked needs_owner and put in front
 * of the owner.
 *
 * Email content is untrusted data: subjects and senders are recorded verbatim
 * and never executed, and no link inside an email is followed here.
 *
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/scan-email-invoices.mts [--days=7]
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { pool } from "../lib/db"

const run = promisify(execFile)
const daysArg = process.argv.find((a) => a.startsWith("--days="))
const DAYS = daysArg ? Number(daysArg.split("=")[1]) : 7
const BATCH = 100          // Mail wedges on large index ranges; keep calls small
const MAX_INDEX = Number(process.argv.find((a) => a.startsWith("--max="))?.split("=")[1] ?? 600)

// Mailboxes to sweep. The Inbox alone is NOT enough: Outlook's Clutter folder
// auto-files "low priority" mail and holds 18k messages here, and supplier
// invoices routinely land in it. Archive likewise. Scanning only the Inbox is
// how invoices go missing without anyone noticing.
const MAILBOXES = (process.argv.find((a) => a.startsWith("--mailbox="))?.split("=")[1] ?? "Inbox").split(",")

// Link-only invoices (Xero/QuickBooks "view your invoice" mails, merchant
// e-billing portals) carry no attachment at all, so an attachment-led scan
// misses them entirely. These patterns catch them for review.
const LINKY = /invoice|statement|remittance|e-?billing|payment (is )?due|amount due|receipt|bill\b|overdue|reminder/i

/** Document types a supplier invoice actually arrives as. Deliberately broad — a false candidate costs a review, a missed one costs money. */
const DOC = /\.(pdf|docx?|xlsx?|jpe?g|png|heic)$/i
/** Images this size or smaller are email-signature furniture, not documents. */
const SIGNATURE_NOISE = /^(image\d+\.(png|jpe?g|gif)|logo.*\.(png|jpe?g)|.*signature.*)$/i

async function osa(script: string): Promise<string> {
  const { stdout } = await run("osascript", ["-e", script], { maxBuffer: 20 * 1024 * 1024 })
  return stdout
}

/** One batch of the inbox as `key|||date|||sender|||subject|||attachments` lines. AppleScript has no \xNN escape, so the delimiter must be plain text. */
function batchScript(from: number, to: number, days: number, mailbox: string) {
  const box = mailbox === "Inbox" ? "inbox" : `mailbox "${mailbox}" of account "Exchange"`
  return `
tell application "Mail"
  with timeout of 55 seconds
    set out to ""
    repeat with i from ${from} to ${to}
      try
        set m to message i of ${box}
        set d to date received of m
        if d > ((current date) - (${days} * days)) then
          set att to ""
          repeat with a in mail attachments of m
            try
              set att to att & (name of a) & ";"
            end try
          end repeat
          -- AppleScript's date-as-string ("Friday, 21 August 2026 at 16:07:23") is not
          -- parseable by JS Date, so emit the parts and assemble an ISO date in TS.
          set ds to ((year of d) as string) & "-" & ((month of d as integer) as string) & "-" & ((day of d) as string) & " " & ((hours of d) as string) & ":" & ((minutes of d) as string) & ":" & ((seconds of d) as string)
          set out to out & (message id of m) & "|||" & ds & "|||" & (sender of m) & "|||" & (subject of m) & "|||" & att & linefeed
        end if
      end try
    end repeat
    return out
  end timeout
end tell`
}

/** "2026-8-21 16:7:23" (AppleScript parts, unpadded) -> ISO. Returns null rather than an invalid date. */
function isoFromParts(raw: string): string | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec((raw ?? "").trim())
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  const pad = (v: string) => v.padStart(2, "0")
  const iso = new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}`)
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString()
}

const rows: { key: string; date: string; sender: string; subject: string; atts: string[]; box: string }[] = []
for (const box of MAILBOXES) {
 console.log(`\nmailbox: ${box}`)
 for (let start = 1; start <= MAX_INDEX; start += BATCH) {
  const end = Math.min(start + BATCH - 1, MAX_INDEX)
  let out = ""
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { out = await osa(batchScript(start, end, DAYS, box)); break } catch (e: any) {
      console.error(`  batch ${start}-${end} attempt ${attempt} failed: ${String(e.message).slice(0, 80)}`)
      if (attempt === 2) throw new Error(`Mail did not respond for messages ${start}-${end} — the scan is INCOMPLETE, high-water mark not advanced.`)
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
  for (const line of out.split("\n")) {
    if (!line.trim()) continue
    const [key, date, sender, subject, atts] = line.split("|||")
    if (!key) continue
    rows.push({ key, date, sender: sender ?? "", subject: subject ?? "", atts: (atts ?? "").split(";").filter(Boolean), box })
  }
  process.stdout.write(`  scanned ${start}-${end} (${rows.length} in window)\r`)
 }
}
console.log(`\nmessages in the last ${DAYS} days: ${rows.length}`)

// Attachment-led: a message carrying a real document is a candidate, whatever
// the subject says. Signature images alone are not a document.
const candidates = rows.filter(
  (r) => r.atts.some((a) => DOC.test(a) && !SIGNATURE_NOISE.test(a)) || LINKY.test(r.subject),
)
console.log(`candidates (document or invoice-like subject): ${candidates.length}`)

let inserted = 0, already = 0
for (const c of candidates) {
  const res = await pool.query(
    `INSERT INTO email_invoice_candidates (message_key, received_at, sender, subject, attachments, status)
     VALUES ($1, $2, $3, $4, $5, 'found')
     ON CONFLICT (message_key) DO UPDATE SET attachments = EXCLUDED.attachments, updated_at = now()
     RETURNING (xmax = 0) AS is_new`,
    [c.key, isoFromParts(c.date), c.sender, c.subject, c.atts.join("; ")],
  )
  res.rows[0].is_new ? inserted++ : already++
}
await pool.query(`UPDATE email_harvest_state SET last_scanned_to = now(), updated_at = now() WHERE id = 1`)

const { rows: open } = await pool.query(
  `SELECT to_char(received_at,'YYYY-MM-DD') d, sender, subject, attachments
     FROM email_invoice_candidates WHERE status IN ('found','saved') ORDER BY received_at DESC`)
console.log(`\nnew: ${inserted} | already tracked: ${already}`)
console.log(`\n--- AWAITING ACTION (${open.length}) — this run is not complete until every one is resolved ---`)
for (const o of open) console.log(`  ${o.d}  ${String(o.sender).slice(0, 38).padEnd(39)} ${String(o.subject).slice(0, 44).padEnd(45)} [${String(o.attachments).slice(0, 40)}]`)
await pool.end()
