/**
 * Ingest the four Bradfords credit notes as CREDIT documents.
 *
 * Owner decision 2026-08-23: credits are recorded as their own negative
 * document referencing the invoice they relate to, NOT netted into that
 * invoice. Tom pays Bradfords in monthly batches against the account balance,
 * so what matters is that the OS balance equals the account balance; and
 * netting a credit into an invoice would silently alter a figure that came off
 * a real document (non-negotiable #4 — raw values are immutable audit fields).
 *
 * Amounts are stored NEGATIVE, matching the repo convention for credits, and
 * transaction_type = 'credit' so a credit can never be read as an invoice or
 * pushed to Xero as a bill by the invoice pipeline.
 *
 * Every value below was transcribed verbatim from the credit note PDF text
 * layer — nothing is derived or inferred.
 *
 * Idempotent: re-running inserts nothing (guarded on supplier + type + number).
 */
import { readFileSync } from "node:fs"
import pg from "pg"
import { put } from "@vercel/blob"
import { createHash } from "node:crypto"

for (const l of readFileSync("/Users/tomgilbert/GilbertOS/.env.development.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const EXECUTE = process.argv.includes("--execute")
const DIR = "/Users/tomgilbert/Downloads/chased-invoices/2026-08-23-bradfords"

const CREDITS = [
  { number: "50835917", date: "2025-12-05", net: 20.00, vat: 4.00, gross: 24.00, against: "77534207",
    desc: "S Morris Returnable Pallet Charge (PAL029) x1 @ 20.00 — credit against invoice 77534207" },
  { number: "50864517", date: "2026-05-26", net: 115.59, vat: 23.12, gross: 138.71, against: "78167671",
    desc: "F P McCann Prestressed Concrete Lintel 100 x 140 x 2400mm (LCP820) x3 @ 38.53 — credit against invoice 78167671" },
  { number: "50866214", date: "2026-06-02", net: 52.23, vat: 10.45, gross: 62.68, against: "78124076",
    desc: "IG L10 Standard Structural Steel Lintel 1500mm (IGB893) x1 @ 32.97; IG L10 Standard Structural Steel Lintel 900mm (IGB889) x1 @ 19.26 — credit against invoice 78124076" },
  { number: "50878293", date: "2026-07-30", net: 87.00, vat: 17.40, gross: 104.40, against: "78456186",
    desc: "PolyGuard Pipe Coil 32mm x 50mtr Blue (PPL132) — credit against invoice 78456186" },
]

for (const c of CREDITS) {
  if (Math.round(c.net * 100) + Math.round(c.vat * 100) !== Math.round(c.gross * 100)) {
    console.error(`ARITHMETIC FAIL on ${c.number} — refusing to write`); process.exit(1)
  }
}
console.log(`${CREDITS.length} credits, total £${CREDITS.reduce((s, c) => s + c.gross, 0).toFixed(2)} (stored negative)`)

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const client = await pool.connect()
try {
  const { rows: [sup] } = await client.query("SELECT id FROM suppliers WHERE name ILIKE '%bradfords%' ORDER BY id LIMIT 1")
  if (!sup) throw new Error("Bradfords supplier not found")
  const { rows: [proj] } = await client.query("SELECT id FROM projects WHERE slug = 'higher-farm'")

  for (const c of CREDITS) {
    const dup = await client.query(
      "SELECT id FROM invoices WHERE supplier_id = $1 AND transaction_type = 'credit' AND invoice_number = $2",
      [sup.id, c.number])
    if (dup.rowCount > 0) { console.log(`  SKIP ${c.number} — already present (#${dup.rows[0].id})`); continue }
    if (!EXECUTE) { console.log(`  WOULD INSERT credit ${c.number} ${c.date} -£${c.gross.toFixed(2)}`); continue }

    const file = `${DIR}/CN-${c.number}.pdf`
    const buf = readFileSync(file)
    const hash = createHash("sha256").update(buf).digest("hex")
    const blob = await put(`credits/${c.number}-bradfords.pdf`, buf, {
      access: "public", token: process.env.BLOB_READ_WRITE_TOKEN, addRandomSuffix: true,
    })
    // Link to the invoice it credits, matching the existing MKM credits:
    // negative amounts, payment_status NULL, credit_of_invoice_id set.
    const { rows: [orig] } = await client.query(
      "SELECT id FROM invoices WHERE supplier_id = $1 AND transaction_type = 'invoice' AND invoice_number = $2",
      [sup.id, c.against])
    await client.query("BEGIN")
    const { rows: [inv] } = await client.query(
      `INSERT INTO invoices (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
         net, vat, gross, status, credit_of_invoice_id, notes,
         source_file_name, source_file_pathname, source_file_hash)
       VALUES ($1,$2,$3,$4::date,'credit',$5,$6,$7,'confirmed',$8,$9,$10,$11,$12) RETURNING id`,
      [sup.id, proj?.id ?? null, c.number, c.date, -c.net, -c.vat, -c.gross, orig?.id ?? null,
       `Bradfords credit note against invoice ${c.against}${orig ? ` (OS #${orig.id})` : " (original not found in the OS)"}. Recorded as a standalone negative document per owner decision 2026-08-23 — never netted into the original invoice.`,
       `CN-${c.number}.pdf`, blob.url, hash])
    await client.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price_ex_vat, line_net, is_price_tracked)
       VALUES ($1,$2,1,$3,$3,false)`, [inv.id, c.desc, -c.net])
    await client.query("COMMIT")
    console.log(`  INSERTED credit ${c.number} -£${c.gross.toFixed(2)} -> #${inv.id}  (+doc)`)
  }
  const { rows: [bal] } = await client.query(
    `SELECT COALESCE(SUM(gross),0) t FROM invoices i JOIN suppliers s ON s.id=i.supplier_id
      WHERE s.name ILIKE '%bradfords%' AND i.status='confirmed'`)
  console.log(`\nBradfords net total in the OS: £${Number(bal.t).toFixed(2)}`)
} catch (e) { await client.query("ROLLBACK").catch(()=>{}); console.error("failed:", e.message); process.exit(1) }
finally { client.release(); await pool.end() }
