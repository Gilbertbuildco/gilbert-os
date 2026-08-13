/**
 * Bulk classification of Bradfords line items — owner-reviewed plan, 2026-08-13.
 *
 * The owner instructed (2026-08-13): review the ingested invoices and classify
 * their components, applying build-sequence logic (the same material early in
 * the project is groundworks; later it is walling/superstructure). This script
 * applies the resulting explicit product -> package plan. Eleven items the
 * owner has not yet decided (chimney/abutment group, roof windows, buried
 * utility pipe/duct) are NOT in the plan and stay unclassified.
 *
 * Semantics mirror classifyInvoiceLine/commitInvoice exactly:
 *   - only lines whose cost_package_id IS NULL are touched (never overwrites)
 *   - each assignment upserts classification_mappings on the same conflict
 *     target with times_confirmed + 1 — these are owner-delegated confirmations
 *   - packages are resolved per project; lines whose invoice has no project
 *     are skipped and reported
 *
 * Dry run by default; --execute to write. Insert/update only, no deletes.
 */

import pg from "pg"

const EXECUTE = process.argv.includes("--execute")

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Run with: node --env-file=.env.development.local scripts/classify-bradfords-2026-08.mjs")
  process.exit(1)
}

// --- lib/normalisation/products.ts, reproduced (this is a plain .mjs script) --
const NOISE_PATTERNS = [
  /\bpriced?\s+from\s+quote\b.*$/i,
  /\bquote\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bq\d{4,}\b/i,
  /\border\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bref\.?\s*[:#]?\s*[a-z0-9-]+/i,
]
function normaliseProductName(description) {
  if (!description) return ""
  let s = description
  for (const re of NOISE_PATTERNS) s = s.replace(re, " ")
  return s.replace(/\s+/g, " ").trim().toUpperCase()
}
function normaliseDescriptionKey(description) {
  return normaliseProductName(description)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Plan keys are the raw description lowercased with whitespace collapsed.
const planKey = (d) => d.toLowerCase().replace(/\s+/g, " ").trim()

const PLAN = new Map([
  ["plot 3 windows", "06"],
  ["plot 2 windows", "06"],
  ["plot 1 windows", "06"],
  ["vandersanden cottage mix bricks 65mm", "04"],
  ["surecav cavity spacer system 1200x450x25mm (each) black", "04"],
  ["knauf wallboard se plasterboard 2400 x 1200 x 15mm", "11"],
  ["woodpecker trade classic candied oak (2.888m2)", "16"],
  ["modula clay double roman tile 445x330mm chiltern red", "05"],
  ["blue circle snowcrete white cement 25kg", "04"],
  ["gt513 - evolve half round gutter", "05"],
  ["milled lead flashing - code 5 - 46kg roll 600mm x 3mtr", "05"],
  ["thistle multi finish plaster 25kg bag", "11"],
  ["cls vac vac treated 50 x 150mm x 4.8mtr length (min fin size 38x140mm) 70% pefc certified", "07"],
  ["blue circle hydralime hydrated lime 25kg bag", "04"],
  ["concrete block 7.3n 100mm", "04"],
  ["keylite sun lite flexi sysytem tile roof 350mm", "05"],
  ["unilin xt pr rigid pir insulation board 2400 x 1200 x 25mm", "19"],
  ["gt523 - evolve half round 76mm diameter outlet", "05"],
  ["milled lead flashing - code 4 - 24kg roll 390mm x 3mtr", "05"],
  ["surecav cavity spacer system fixings 23mm dia x 10mm (bag of 50) black", "04"],
  ["hallstone blended loam topsoil - 500ltr bulk bag", "17"],
  ["l10/xxhd wol 150 2550mm", "04"],
  ["timber frame ties 100mm c/w 50mm x 3.35mm stainless steel annular ring nails (each)", "04"],
  ["iko enertherm pir rigid insulation board 2400 x 1200 x 25mm", "19"],
  ["whitewood door lining set & stop - 32 x 150mm 2'6\"/2'9\" (min fin size 27x144mm) 70% pefc certified", "08"],
  ["milled lead flashing - code 4 - 48kg roll 390mm x 6mtr", "05"],
  ["timloc 1 hour fire rated cavity stop sock 65 x 65 x 1200mm", "04"],
  ["ig xhd l10 wol structural steel lintel 2550mm", "04"],
  ["osb3 structural board bba & ce 2397 x 1197 x 9mm fsc mix 70% sa-coc-013511", "08"],
  ["gt580 - evolve half round fascia bracket", "05"],
  ["cls 50 x 100mm x 2.4mtr length (min fin size 38x89mm) 70% pefc certified sa-pefc-coc-013511", "07"],
  ["milled lead flashing - code 4 - 55kg roll 900mm x 3mtr", "05"],
  ["square hole airbrick no.350 215 x 65mm buff", "02"],
  ["socli natural nhl 3.5 hydraulic lime 25kg", "04"],
  ["vermiculite micafil insulation 100ltr", "19"],
  ["gt555 - evolve half round stop end (external)", "05"],
  ["ig l10 standard structural steel lintel 2400mm", "04"],
  ["square hole airbrick no.350 215 x 65mm red", "02"],
  ["gt520 - evolve half round union", "05"],
  ["25mm x 6-15mm x 4.3m exp6 black expanding foam tape", "06"],
  ["milled lead flashing - code 4 - 37kg roll 600mm x 3mtr", "05"],
  ["rooftx maxi breathable roofing membrane 170gsm 1m x 50m (50m2) black", "05"],
  ["f p mccann prestressed concrete lintel 100 x 140 x 1800mm", "04"],
  ["sc208 - m6 x 70mm hex coachscrew", "05"],
  ["milwaukee m18 brushless percussion drill & impact driver twin pack, 5.0ah li-ion & fast charger", "01"],
  ["ig l10 standard structural steel lintel 2100mm", "04"],
  ["surecav cavity spacer system 1200x450x50mm (each) black", "04"],
  ["plywood 2440 x 1220 x 18mm exterior hardwood throughout en636-3 fsc mix 70% sa-coc-013511", "08"],
  ["catnic dwtc2.4 drywall thin coat angle bead 2.4mtr galvanised", "11"],
  ["mdf mr primed chamfered & grooved contemporary skirting 18 x 119mm x 4.2m length fsc mix 70%", "12"],
  ["47 x 100mm (fin 45x95mm) 4.8mtr length - sawn treated regularised c24 kiln dried carcassing timber 70% pefc", "08"],
  ["timber frame ties 50mm c/w 50mm x 3.35mm stainless steel annular ring nails (each)", "04"],
  ["25 x 50mm x 4.8mtr length - sawn bs5534 blue/gold treated batten 70% pefc certified", "05"],
  ["telescopic under floor vent", "02"],
  ["f p mccann prestressed concrete lintel 100 x 140 x 2400mm", "04"],
  ["mexicano solid core internal door - prefinished - 1981 x 762mm oak pfomex30", "12"],
  ["werner trade fibreglass 6 tread swingback stepladder 1.7mtr", "01"],
  ["milwaukee m18 reciprocating sawzall", "01"],
  ["contractors heavy duty wheelbarrow 85ltr black", "01"],
  ["ig l10 standard structural steel lintel 1500mm", "04"],
  ["paslode im360ci nail fuel pack 2200pk & 2 fuel cells 3.1 x 75mm ring galv+", "01"],
  ["polythene damp proof membrane handy pack (300mu) 4mtr x 5mtr - black", "04"],
  ["f p mccann prestressed concrete lintel 100 x 140 x 1500mm", "04"],
  ["ig l10 standard structural steel lintel 3000mm", "04"],
  ["osb3 structural board bba & ce 2440 x 1220 x 18mm fsc mix 70% sa-coc-013511", "08"],
  ["ulti-mate stick-fit high performance woodscrews 4.0 x 70mm (tub of 600)", "01"],
  ["sc201 - m5 x 30mm roundhead screw - mill finish", "05"],
  ["polythene damp proof course 300mm x 30mtr", "04"],
  ["principal hi-tac self adhesive drywall tape 50mm x 90m pink", "11"],
  ["catnic cm114/20 coil mesh 114mm x 20mtr roll galvanised", "04"],
  ["rhino multi purpose gaffer tape 50mm x 50mtr (pack of 2) black", "01"],
  ["timco classic multi-purpose c2 screw 6.0 x 150mm zinc/yell pass (box of 100)", "01"],
  ["knauf wallboard se plasterboard 2400 x 1200 x 9.5mm", "11"],
  ["siteworx foam expansion joint filler 10mm x 100mm x 10mtr white", "04"],
  ["ob1 diamond universal sealant & adhesive 290ml crystal clear", "01"],
  ["movement ties 200mm stainless steel", "04"],
  ["paslode series-i fuel cell for im360ci and ppn35ci", "01"],
  ["ig l10 standard structural steel lintel 1800mm", "04"],
  ["cavity wall weep vent 65 x 10 x 100mm buff", "04"],
  ["polyethylene tarpaulin 7.2 x 5.4mtr (24' x 18')", "01"],
  ["ig l10 standard structural steel lintel 1200mm", "04"],
  ["f p mccann prestressed concrete lintel 100 x 140 x 1200mm", "04"],
  ["blue circle mastercrete cement 25kg plastic bag", "04"],
  ["knauf plasterboard adhesive bonding compound 25kg off white", "11"],
  ["evo-stik plasterboard gun grade adhesive foam 750ml yellow", "11"],
  ["47 x 150mm (fin 45x145mm) 3.6mtr length - sawn treated regularised c24 kiln dried carcassing timber", "08"],
  ["knauf loft roll 44 combi cut insulation 100 x 1140mm x 12.18m (13.89m2)", "19"],
  ["plywood 2440 x 1220 x 12mm exterior hardwood throughout en636-3 fsc mix 70% sa-coc-013511", "08"],
  ["marshalltown braided nylon mason's line on plastic winder 250ft orange", "01"],
  ["ulti-mate stick-fit high performance woodscrews 4.0 x 40mm (tub of 1000)", "01"],
  ["domus vertical 90deg rect bend 40060", "09"],
  ["milled lead flashing - code 4 - 9kg roll 150mm x 3mtr", "05"],
  ["arrow t50 heavy duty staples 12mm (1/2\") (pack of 1,250)", "01"],
  ["delivery charge", "01"],
  ["timco tx25 c2 clamp-fix multi-purpose screws 5.0 x 70mm csk (tub of 375) yellow", "01"],
  ["broadfix flat packer 28mm assorted 1-6mm (tub of 300)", "01"],
  ["ig l10 standard structural steel lintel 900mm", "04"],
  ["monument 734d lead dresser beechwood", "05"],
  ["timco classic multi-purpose c2 screw 4.0 x 50mm zinc/yell pass (box of 200)", "01"],
  ["evo-stik plasterboard adhesive foam 750ml yellow", "11"],
  ["gravel 20mm - prepacked bag", "02"],
  ["evo-stik sticks like adhesive 290ml white", "01"],
  ["steel reinforcement bar 10mm x 6.2mtr", "02"],
  ["sx contractors lead sheet silicone 300ml - grey", "05"],
  ["rhino multi purpose gaffer tape 50mm x 50mtr (pack of 2) silver", "01"],
  ["bosch sabre sawblades for wood 5pk s1531l", "01"],
  ["timco clout nail 40 x 2.65mm galv (2.5kg tub)", "01"],
  ["lynvale delivery", "01"],
  ["timco solo woodscrew pz2 csk 4.0 x 50mm zinc/yell pass (box of 200)", "01"],
  ["big wipes heavy-duty pro+ wipes - red top (tub of 100)", "01"],
  ["f p mccann prestressed concrete lintel 100 x 65 x 1500mm", "04"],
  ["stanley 2-10-099 99e retractable blade knife", "01"],
  ["timco classic screw pz2 csk 4.0 x 30mm stainless steel (box of 200)", "01"],
  ["movement ties debonding sleeves 150mm", "04"],
  ["revolving sealant gun heavy duty", "01"],
  ["*redhousedeals - red house deals", "01"],
  ["portwest classic ear defender", "01"],
  ["juba smart tip touchscreen gloves orange/black size 9", "01"],
  ["prosolve temporary line marking paint aerosol 750ml blue", "01"],
  ["prosolve temporary line marking paint aerosol 750ml red", "01"],
  ["timco ffp2 moulded valved mask - one size (3 pack)", "01"],
  ["angle bracket ribbed 90 x 90 x 60mm", "08"],
  ["domus s100 flat channel connector 40020d", "09"],
  ["honeywell bilsom 303l foam earplugs snr33db (5 pairs) yellow", "01"],
  ["honeywell percap banded earplugs snr24", "01"],
  ["magnetic bit holder 2 piece", "01"],
  ["heavy duty rubble bags 10pk black", "01"],
])

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const money = (v) => "£" + Number(v ?? 0).toFixed(2)
const client = await pool.connect()

try {
  await client.query("BEGIN")

  const { rows: pkgs } = await client.query(
    "SELECT id, code, name, project_id FROM cost_packages ORDER BY project_id, code",
  )
  const pkgByProjectCode = new Map(pkgs.map((p) => [p.project_id + ":" + p.code, p]))

  const { rows: lines } = await client.query(`
    SELECT li.id, li.description, li.line_net, i.project_id, i.supplier_id
      FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
     WHERE li.cost_package_id IS NULL AND i.status = "confirmed"
     ORDER BY li.id`.replace(/"confirmed"/, "'confirmed'"))

  const byCode = new Map()
  const skipped = []
  const updates = []
  for (const l of lines) {
    const code = PLAN.get(planKey(l.description))
    if (!code) { skipped.push(l); continue }
    const pkg = pkgByProjectCode.get(l.project_id + ":" + code)
    if (!pkg) { skipped.push({ ...l, reason: "no package " + code + " for project " + l.project_id }); continue }
    updates.push({ line: l, pkg })
    const c = byCode.get(code) ?? { n: 0, net: 0, name: pkg.name }
    c.n++; c.net += Number(l.line_net); byCode.set(code, c)
  }

  console.log(`unclassified lines: ${lines.length}; planned updates: ${updates.length}; left for owner: ${skipped.length}`)
  for (const [code, c] of [...byCode].sort()) console.log(`  ${code} ${c.name}: ${c.n} lines ${money(c.net)}`)
  console.log("left unclassified (flagged/no plan):")
  const leftBy = new Map()
  for (const s of skipped) { const k = planKey(s.description); const g = leftBy.get(k) ?? { n: 0, net: 0, d: s.description }; g.n++; g.net += Number(s.line_net); leftBy.set(k, g) }
  for (const g of [...leftBy.values()].sort((a, b) => b.net - a.net)) console.log(`  ${money(g.net)} x${g.n}  ${g.d}`)

  if (!EXECUTE) {
    await client.query("ROLLBACK")
    console.log("\nDRY RUN — nothing written. Re-run with --execute to apply.")
    process.exit(0)
  }

  let updated = 0
  for (const { line, pkg } of updates) {
    const res = await client.query(
      "UPDATE invoice_line_items SET cost_package_id = $1 WHERE id = $2 AND cost_package_id IS NULL",
      [pkg.id, line.id],
    )
    updated += res.rowCount
    const productKey = normaliseDescriptionKey(line.description)
    if (productKey) {
      await client.query(
        `INSERT INTO classification_mappings
           (key_kind, key_value, supplier_id, cost_package_code, cost_package_name, times_confirmed)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
         DO UPDATE SET
           cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
           cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
           times_confirmed = classification_mappings.times_confirmed + 1,
           updated_at = now()`,
        ["product", productKey, line.supplier_id, pkg.code, pkg.name],
      )
    }
  }

  const { rows: [after] } = await client.query(`
    SELECT count(*)::int total, count(cost_package_id)::int classified,
           COALESCE(SUM(line_net) FILTER (WHERE cost_package_id IS NULL), 0) unclassified_net
      FROM invoice_line_items`)

  await client.query("COMMIT")
  console.log(`\nUpdated: ${updated}`)
  console.log(`Line items now: ${after.total} total, ${after.classified} classified, unclassified net ${money(after.unclassified_net)}`)
} catch (err) {
  await client.query("ROLLBACK")
  console.error("Rolled back:", err.message)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
