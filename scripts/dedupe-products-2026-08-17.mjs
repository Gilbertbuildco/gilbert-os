/**
 * Collapse duplicate product rows so one commodity = one product.
 *
 * Owner instruction 2026-08-17: "there should only be one 140 block."
 * Merchants word the same item differently (brand, per-m2 variants, MKM codes),
 * which produced parallel product rows. This repoints price_records and
 * invoice_line_items onto a single winner per family and removes the losers.
 * Prices themselves are never altered — only which product they hang off, so
 * one product now carries every merchant's price for genuine comparison.
 *
 * Winner = the product row with the most price_records (richest history),
 * tie-broken by lowest id. Dry-run default; --execute to write.
 */
import pg from "pg"

const EXECUTE = process.argv.includes("--execute")

// Families of wordings that are one real commodity.
const FAMILIES = [
  { name: "Concrete Block 7.3N 100mm 440 x 215 (dense/solid, any brand)", re: /7\.3n.*100 ?mm|100 ?mm.*7\.3n|dense concrete solid 7\.3n block 440 x 215 x 100/i },
  { name: "Concrete Block 7.3N 140mm 440 x 215 (any brand)", re: /7\.3n.*140|140.*7\.3n/i },
  { name: "Treated Roofing Batten BS5534 25 x 50mm x 4.8m", re: /bs5534.*batten|batten.*bs5534/i },
  { name: "Breathable Roofing Membrane 170gsm 1m x 50m", re: /rooftx|breathable roofing membrane/i },
  { name: "Clay Double Roman Tile 445 x 330mm (Chiltern Red)", re: /modula clay double roman/i },
  { name: "Square Hole Airbrick 215 x 65mm (buff or red)", re: /square hole airbrick/i },
  { name: "PIR Rigid Insulation Board 2400 x 1200 x 25mm (any brand)", re: /(iko enertherm|unilin).*(2400 x 1200 x 25|25 ?mm)/i },
  { name: "PIR Insulation Board 1200 x 2400 x 150mm (any brand)", re: /sopretherm|xr4000/i },
  { name: "Gaffer Tape 50mm x 50m (pack of 2)", re: /gaffer tape/i },
  { name: "Temporary Line Marking Paint 750ml", re: /line marking paint/i },
  { name: "Plasterboard Adhesive Foam 750ml", re: /plasterboard.*adhesive foam|adhesive foam.*plasterboard/i },
]

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const c = await pool.connect()
try {
  await c.query("BEGIN")
  const { rows: products } = await c.query(`
    SELECT p.id, COALESCE(NULLIF(p.normalised_name, ''), p.name) AS normalised_name,
           (SELECT count(*)::int FROM price_records pr WHERE pr.product_id = p.id) AS prices,
           (SELECT count(*)::int FROM invoice_line_items li WHERE li.product_id = p.id) AS lines
      FROM products p ORDER BY p.id`)

  let merged = 0, movedPrices = 0, movedLines = 0, removed = 0
  for (const f of FAMILIES) {
    const members = products.filter((p) => f.re.test(p.normalised_name ?? ""))
    if (members.length < 2) { if (members.length === 1) console.log(`= ${f.name}: already single (product #${members[0].id})`); continue }
    const winner = [...members].sort((a, b) => b.prices - a.prices || a.id - b.id)[0]
    const losers = members.filter((m) => m.id !== winner.id)
    console.log(`\n${f.name}`)
    console.log(`  KEEP  #${winner.id} "${winner.normalised_name}" (${winner.prices} prices, ${winner.lines} lines)`)
    for (const l of losers) console.log(`  MERGE #${l.id} "${l.normalised_name}" (${l.prices} prices, ${l.lines} lines) -> #${winner.id}`)
    merged++
    if (EXECUTE) {
      const ids = losers.map((l) => l.id)
      const pr = await c.query("UPDATE price_records SET product_id = $1 WHERE product_id = ANY($2::int[])", [winner.id, ids])
      const li = await c.query("UPDATE invoice_line_items SET product_id = $1 WHERE product_id = ANY($2::int[])", [winner.id, ids])
      await c.query("UPDATE products SET name = $2, normalised_name = $2 WHERE id = $1", [winner.id, f.name])
      const del = await c.query("DELETE FROM products WHERE id = ANY($1::int[])", [ids])
      movedPrices += pr.rowCount; movedLines += li.rowCount; removed += del.rowCount
    }
  }

  const { rows: [after] } = await c.query("SELECT count(*)::int products, (SELECT count(*)::int FROM price_records) prices FROM products")
  console.log(`\nfamilies merged: ${merged} | price_records repointed: ${movedPrices} | line items repointed: ${movedLines} | product rows removed: ${removed}`)
  console.log(`products now: ${after.products} | price_records: ${after.prices}`)

  if (!EXECUTE) { await c.query("ROLLBACK"); console.log("\nDRY RUN — nothing written.") }
  else { await c.query("COMMIT"); console.log("\nCOMMITTED.") }
} catch (e) { await c.query("ROLLBACK"); console.error("Rolled back:", e.message); process.exit(1) } finally { c.release(); await pool.end() }
