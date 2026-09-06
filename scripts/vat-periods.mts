import { xeroGet } from "../lib/xero/client"

// Filed VAT returns post a journal in Xero. Find them to learn the real stagger.
const seen: any[] = []
for (let offset = 0; ; ) {
  const r = await xeroGet(`/api.xro/2.0/Journals?offset=${offset}`, { headers: { Accept: "application/json" } })
  if (!r.ok) { console.log("Journals ->", r.status, (await r.text()).slice(0, 200)); break }
  const js = (await r.json()).Journals ?? []
  if (!js.length) break
  seen.push(...js)
  offset = js[js.length - 1].JournalNumber
  if (seen.length > 6000) break
}
console.log("journals:", seen.length)
const kinds: Record<string, number> = {}
for (const j of seen) kinds[j.SourceType] = (kinds[j.SourceType] ?? 0) + 1
console.log("source types:", JSON.stringify(kinds))

// Anything that looks like a filed VAT return
for (const j of seen) {
  const st = String(j.SourceType ?? "")
  if (/TAX|VAT/i.test(st)) console.log("  FILED?", j.JournalDate?.slice(0, 10), st, j.Reference ?? "", (j.JournalLines ?? []).reduce((s: number, l: any) => s + (l.NetAmount ?? 0), 0).toFixed(2))
}

// VAT control account balance movements
const ra = await xeroGet("/api.xro/2.0/Accounts", { headers: { Accept: "application/json" } })
const accts = ra.ok ? ((await ra.json()).Accounts ?? []) : []
for (const a of accts) if (/vat|tax/i.test(a.Name) || a.Type === "CURRLIAB" && /820|825/.test(a.Code ?? "")) console.log("  ACCT", a.Code, a.Name, a.Type, "| systemAcct:", a.SystemAccount ?? "-")
process.exit(0)
