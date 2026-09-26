import { pool } from "../lib/db"
const sup = await pool.query(`select id, lower(name) n from suppliers`)
const names = sup.rows.map((r:any)=>({id:r.id, n:String(r.n)}))
const r = await pool.query(
  `select sender, count(*) msgs,
          count(*) filter (where nullif(attachments,'') is not null) docs,
          max(to_char(received_at,'YYYY-MM-DD')) last
     from email_invoice_candidates
    where status='found' and received_at > now() - interval '15 months'
    group by 1 having count(*) filter (where nullif(attachments,'') is not null) > 0
    order by 3 desc`)
const addr = (s:string)=>{const m=/<([^>]+)>/.exec(s??""); return (m?m[1]:s??"").toLowerCase()}
const dom  = (s:string)=>addr(s).split("@")[1] ?? ""
// noise: our own domains, big platforms, personal
const NOISE = /gilbertco|hannahgilbert|apple\.com|google|microsoft|amazon(?!.*business)|paypal|ebay|linkedin|facebook|twitter|instagram|netflix|spotify|uber|deliveroo|justeat|vercel|midjourney|openai|anthropic|github|stripe|slack|zoom|dropbox|adobe|intuit\.com$|sendgrid|mailchimp|hubspot|xero\.com$/i
const unmatched: any[] = [], matched: any[] = []
for (const x of r.rows) {
  const d = dom(x.sender)
  if (!d || NOISE.test(d)) continue
  const stem = d.split(".")[0].replace(/[^a-z]/g,"")
  const hit = names.find(s => stem.length>3 && (s.n.replace(/[^a-z]/g,"").includes(stem) || stem.includes(s.n.replace(/[^a-z]/g,"").slice(0,8))))
  ;(hit ? matched : unmatched).push({ ...x, d, hit: hit?.n })
}
console.log(`senders with documents (last 15 months): ${matched.length + unmatched.length}\n`)
console.log(`### NO SUPPLIER IN THE OS — ${unmatched.length} senders`)
for (const x of unmatched.slice(0, 45))
  console.log(`  ${String(x.docs).padStart(4)} docs  last ${x.last}  ${x.d}`)
console.log(`\n### matched to an existing supplier — ${matched.length}`)
for (const x of matched.slice(0, 25))
  console.log(`  ${String(x.docs).padStart(4)} docs  last ${x.last}  ${x.d.padEnd(30)} -> ${x.hit}`)
process.exit(0)
