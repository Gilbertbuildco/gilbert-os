import { pool } from "../lib/db"
const r = await pool.query(
  `select to_char(received_at,'MM-DD') d, sender, subject,
          coalesce(array_length(string_to_array(nullif(attachments,''), E'\n'),1),0) n
     from email_invoice_candidates
    where status='found' and received_at > now() - interval '35 days'
      and sender not ilike '%gilbertco.co.uk%'
      and sender !~* 'apple|google|microsoft|paypal|linkedin|facebook|instagram|netflix|spotify|uber|vercel|midjourney|openai|anthropic|github|stripe|slack|zoom|dropbox|adobe|sendgrid|meta\\.com|tradingview|nike|sohohouse|kingsbruton|lloydsbank|eonnext|starlink|bonline|b online'
    order by received_at desc`)
console.log(`${r.rows.length} candidates in the last 35 days\n`)
for (const x of r.rows)
  console.log(`${x.d} ${x.n?`[${String(x.n).padStart(2)}]`:"    "} ${String(x.sender).replace(/"/g,"").slice(0,40).padEnd(41)} ${String(x.subject).replace(/\s+/g," ").slice(0,52)}`)
process.exit(0)
