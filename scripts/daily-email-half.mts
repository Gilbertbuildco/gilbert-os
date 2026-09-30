/**
 * The email half of the daily job, as ONE deterministic run.
 *
 * Why this exists: the Claude scheduled task DOES have Full Disk Access (launchd
 * does not), but on 29 Sep 2026 it spent its whole session exploring the repo and
 * ended on the words "Running the sweep." The job is 15 seconds of work behind an
 * 8KB prompt that invited twenty minutes of looking around. So the task now runs
 * this, and nothing else.
 *
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/daily-email-half.mts
 */
import { execFileSync } from "node:child_process"
import { pool } from "../lib/db"

const days = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 7)
const started = Date.now()
console.log(`=== Gilbert OS email half — ${new Date().toISOString().slice(0, 16).replace("T", " ")} ===\n`)

let sweepOut = ""
try {
  sweepOut = execFileSync("npx", ["tsx", "--env-file=.env.local", "--env-file=.env.development.local",
    "scripts/sweep-mail-store.mts", `--days=${days}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 })
} catch (e: any) {
  const msg = String(e?.stdout ?? "") + String(e?.stderr ?? e?.message ?? "")
  console.log("SWEEP FAILED — the email half did not run.\n")
  console.log(msg.split("\n").filter((l) => !/SECURITY WARNING|sslmode|^\(node|major version|To prepare|See https/.test(l)).slice(0, 12).join("\n"))
  if (/No mail files readable/.test(msg))
    console.log("\nCAUSE: the Mail store was unreadable — this process has no Full Disk Access.\nThat is expected under launchd and NOT expected here; if you see it, the task's\nexecution context has changed.")
  process.exitCode = 1
  await pool.end(); process.exit(1)
}
console.log(sweepOut.split("\n").filter((l) => !/SECURITY WARNING|sslmode|^\(node|major version|To prepare|See https/.test(l) && l.trim()).join("\n"))

// What is now waiting, and what the owner actually needs to see.
const q = await pool.query(
  `select to_char(received_at,'MM-DD') d, sender, subject,
          coalesce(array_length(string_to_array(nullif(attachments,''), E'\n'),1),0) n
     from email_invoice_candidates
    where status='found' and received_at > now() - interval '14 days'
      and sender not ilike '%gilbertco.co.uk%'
    order by received_at desc limit 30`)
console.log(`\n--- ARRIVED IN THE LAST 14 DAYS (${q.rows.length}) ---`)
for (const r of q.rows)
  console.log(`  ${r.d} ${r.n ? `[${String(r.n).padStart(2)}]` : "    "} ${String(r.sender).replace(/"/g, "").slice(0, 34).padEnd(35)} ${String(r.subject).replace(/\s+/g, " ").slice(0, 52)}`)

const st = await pool.query(
  `select count(*) n, sum(gross)::numeric g from invoices where transaction_type='invoice'`)
const un = await pool.query(
  `select count(*) n, sum(gross-coalesce(amount_paid,0))::numeric g from invoices
    where transaction_type='invoice' and coalesce(payment_status,'unpaid')<>'paid'`)
console.log(`\nOS: ${st.rows[0].n} invoices, ${Number(st.rows[0].g).toFixed(2)}  |  unpaid ${un.rows[0].n}, ${Number(un.rows[0].g).toFixed(2)}`)
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
await pool.end()
