import { pool } from "../lib/db"

/** Subject patterns that yield a real supplier invoice number. */
const PAT: [RegExp, string][] = [
  [/Bradfords Building Supplies Invoice No\.?\s*(\d{7,9})/i, "Bradfords"],
  [/TP Invoice\s*\((\d{9,11})\)/i, "Travis Perkins"],
  [/Invoice\(s\)\s*(\d{9,11})/i, "Porcelanosa"],
  [/Invoice\s+(\d{3})\s+from JR Carpentry/i, "JR Carpentry"],
  [/Invoice\s+(\d{4})\s+from PNTR/i, "PNTR"],
  [/Structural Solutions Invoice\s*(\d{4,6})/i, "Structural Solutions"],
  [/Invoice\s+#?(INV-\d{3,5})\s+from ([A-Za-z0-9 .'&-]+?)\s+(?:for|is)/i, ""],
  [/Invoice\s+(SM\d{2})/i, "George Wilson"],
]
const r = await pool.query(
  `select to_char(received_at,'YYYY-MM-DD') d, sender, subject, attachments
     from email_invoice_candidates where status='found' order by received_at desc nulls last`)

type Row = { d: string; supplier: string; num: string; subject: string; docs: string[] }
const found: Row[] = []
for (const x of r.rows) {
  const subj = String(x.subject ?? "").replace(/\s+/g, " ")
  for (const [re, sup] of PAT) {
    const m = re.exec(subj)
    if (!m) continue
    found.push({ d: x.d, supplier: sup || (m[2] ?? "").trim(), num: m[1],
                 subject: subj, docs: String(x.attachments ?? "").split("\n").filter(Boolean) })
    break
  }
}
// de-dupe the same invoice arriving twice
const seen = new Set<string>()
const uniq = found.filter((f) => { const k = `${f.supplier}|${f.num}`; if (seen.has(k)) return false; seen.add(k); return true })

const already: Row[] = [], missing: Row[] = []
for (const f of uniq) {
  const q = await pool.query(
    `select 1 from invoices i join suppliers s on s.id = i.supplier_id
      where i.invoice_number = $1 and lower(s.name) like '%' || lower($2) || '%' limit 1`,
    [f.num, f.supplier.split(" ")[0]])
  ;(q.rows.length ? already : missing).push(f)
}
console.log(`invoice numbers parsed from the queue: ${uniq.length}`)
console.log(`  already in the OS: ${already.length}`)
console.log(`  NOT in the OS:     ${missing.length}\n`)
const by: Record<string, Row[]> = {}
for (const m of missing) (by[m.supplier] ??= []).push(m)
for (const [sup, rows] of Object.entries(by).sort((a,b) => b[1].length - a[1].length)) {
  console.log(`### ${sup} — ${rows.length} missing`)
  for (const x of rows.sort((a,b)=>a.d.localeCompare(b.d)))
    console.log(`  ${x.d}  ${x.num.padEnd(12)} ${x.docs.length ? x.docs[0].split("/").pop() : "(no doc — link-based)"}`)
}
process.exit(0)
