import { xeroGet } from "../lib/xero/client"
const parse = (v: any) => { const m = /\/Date\((\d+)/.exec(String(v ?? "")); return m ? new Date(Number(m[1])).toISOString().slice(0,10) : String(v ?? "").slice(0,10) }
// Every bill that showed on the July return's late-claims section
for (const num of ["77983446", "77983461", "5030", "15033", "CP-JUN2026-CONSOL", "77812181", "77824775"]) {
  const s = await xeroGet(`/api.xro/2.0/Invoices?where=InvoiceNumber=="${num}"`, { headers: { Accept: "application/json" } })
  const b = ((await s.json()).Invoices ?? [])[0]
  if (!b) { console.log(`${num.padEnd(20)} not found`); continue }
  const h = await xeroGet(`/api.xro/2.0/Invoices/${b.InvoiceID}/History`, { headers: { Accept: "application/json" } })
  const recs = h.ok ? ((await h.json()).HistoryRecords ?? []) : []
  const created = recs.find((r: any) => /created/i.test(r.Changes ?? ""))
  const approved = recs.find((r: any) => /approved/i.test(r.Changes ?? ""))
  console.log(`${num.padEnd(20)} dated ${parse(b.Date)}  CREATED ${created ? parse(created.DateUTC) : "?"}  APPROVED ${approved ? parse(approved.DateUTC) : "?"}  VAT now ${b.TotalTax}`)
}
process.exit(0)
