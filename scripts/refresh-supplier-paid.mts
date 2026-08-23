/**
 * Refresh the cached "paid per supplier" snapshot from Xero.
 * Read-only against Xero; the OS side is a plain upsert.
 */
import { pool } from "../lib/db"
import { normaliseSupplierName } from "../lib/invoice-identity"
import { xeroGet } from "../lib/xero/client"

const res = await xeroGet(`/api.xro/2.0/BankTransactions?where=${encodeURIComponent('Type=="SPEND"')}`, { headers: { Accept: "application/json" } })
const spend = (((await res.json()) as any).BankTransactions ?? []).filter((t: any) => t.Status !== "DELETED")

const agg = new Map<string, { gross: number; net: number; n: number }>()
for (const t of spend) {
  const name = (t.Contact?.Name ?? "").trim()
  if (!name) continue
  const net = (t.LineItems ?? []).reduce((a: number, l: any) => a + Number(l.LineAmount ?? 0), 0)
  const g = agg.get(name) ?? { gross: 0, net: 0, n: 0 }
  g.gross += Number(t.Total); g.net += net || Number(t.Total); g.n++
  agg.set(name, g)
}

const { rows: sups } = await pool.query("SELECT id, name FROM suppliers")
const { rows: aliases } = await pool.query("SELECT supplier_id, normalised_name FROM supplier_aliases")
const byNorm = new Map<string, number>()
for (const s of sups) byNorm.set(normaliseSupplierName(s.name), s.id)
for (const a of aliases) byNorm.set(a.normalised_name, a.supplier_id)

let n = 0
for (const [name, g] of agg) {
  const supplierId = byNorm.get(normaliseSupplierName(name)) ?? null
  await pool.query(
    `INSERT INTO supplier_external_paid (supplier_id, contact_name, paid_net, paid_gross, transactions, source, refreshed_at)
     VALUES ($1,$2,$3,$4,$5,'xero',now())
     ON CONFLICT (source, contact_name) DO UPDATE
       SET supplier_id = EXCLUDED.supplier_id, paid_net = EXCLUDED.paid_net,
           paid_gross = EXCLUDED.paid_gross, transactions = EXCLUDED.transactions, refreshed_at = now()`,
    [supplierId, name, g.net, g.gross, g.n])
  n++
}
console.log(`refreshed ${n} suppliers from ${spend.length} Xero payments`)
const { rows: top } = await pool.query(
  `SELECT contact_name, paid_net, transactions FROM supplier_external_paid ORDER BY paid_net DESC LIMIT 8`)
for (const t of top) console.log(`  £${Number(t.paid_net).toFixed(2).padStart(12)}  ${t.transactions}  ${t.contact_name}`)
await pool.end()
