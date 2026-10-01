import { pool } from "../lib/db"
const TARGETS: [string,string][] = [
  ["Metal Stairs","metalstairs|stairbox|metal stair"],
  ["Hopkins Concrete","hopkins"],
  ["S Morris","smorris|s morris"],
  ["Protek","protek"],
  ["A & R Tiles","a ?& ?r tiles|artiles"],
  ["Battens","battens"],
  ["Golden Tree","goldentree|golden tree"],
]
for (const [label, rx] of TARGETS) {
  const r = await pool.query(
    `select to_char(received_at,'YYYY-MM-DD') d, sender, subject,
            coalesce(array_length(string_to_array(nullif(attachments,''), E'\n'),1),0) n, attachments
       from email_invoice_candidates
      where (sender ~* $1 or subject ~* $1) and received_at > now() - interval '8 months'
      order by received_at desc limit 8`, [rx])
  console.log(`\n### ${label} — ${r.rows.length} emails`)
  for (const x of r.rows) {
    console.log(`  ${x.d} ${x.n?`[${x.n}]`:"   "} ${String(x.subject).replace(/\s+/g," ").slice(0,56)}`)
    for (const p of String(x.attachments??"").split("\n").filter(Boolean).slice(0,3))
      console.log(`         ${p.split("/").pop()}`)
  }
}
process.exit(0)
