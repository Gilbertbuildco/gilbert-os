/**
 * Owner decisions, 2026-08-18 — Higher Farm (project_id 1).
 *
 * 1. NEW COST PACKAGE — code '22' "Utilities & Service Connections". This is
 *    a Gilbert OS internal cost-plan package only. `original_budget` is
 *    DELIBERATELY left NULL — copying a lender allowance in here would blur
 *    the lender baseline (funding_budget_lines, immutable, non-negotiable
 *    #2) with Gilbert Build Co's own cost plan. Existing packages run
 *    '01'..'21' but ids are NOT aligned to codes (code '20' is id 22, code
 *    '21' is id 23) — this script never hardcodes the new package's id, it
 *    resolves it after insert (or after find, on re-run).
 *
 * 2. MAP THREE LENDER LINES TO IT — funding_line_package_map had zero rows
 *    for these. One row per line, all pointing at the new package:
 *      line 87 'Mains Electricity Supplies and Metering'  £19,089.72
 *      line 90 'Mains Water Supplies & Metering'           £6,065.00
 *      line 91 'BT and Broadband'                          £2,959.82
 *    `weight` is left NULL on all three. Per lib/funding/calculations.ts
 *    (computeShares/apportionSpend), when a package maps to >1 funding line
 *    and not every edge carries an explicit weight, the engine falls back to
 *    splitting that package's actual spend across its lines in proportion to
 *    each line's own ORIGINAL (lender) amount — a defensible, documented
 *    basis, not an invented one. This is also the existing production
 *    pattern: every other package in funding_line_package_map that maps to
 *    more than one line (ids 3, 17, 13, 9, 10, 5, 18, 2, 6, 12, 23 as
 *    verified live) has weight NULL throughout. NEVER touches
 *    funding_budget_lines itself (non-negotiable #2).
 *
 * 3. CLASSIFY INVOICE LINES (cost_package_id, currently NULL on every one):
 *      - invoice 212 line 400 (Scotish and Sothern Electricity Networks,
 *        ': FGG947/1', £19,089.72)      -> package 22
 *      - invoice 211 line 399 (Wessex Water, 'QS55335', £6,065.00) -> pkg 22
 *      - MKM drainage lines 462-466 (+ credit lines 467, 468, which keep
 *        their negative line_gross — never altered) -> package '18' Drainage
 *      - MKM blockwork lines 456-461 (owner-confirmed 2026-08-18 early-stage
 *        groundworks) -> package '02' Groundworks & Foundations
 *    Package ids for '18'/'02' are resolved by code from cost_packages, never
 *    hardcoded. Updates are guarded `WHERE cost_package_id IS NULL` so a
 *    re-run never overwrites a value set some other way in the meantime.
 *
 * 4. LEARNING (non-negotiable #7) — upsert classification_mappings for the
 *    13 MKM lines only (key_kind='product', normalised description key,
 *    supplier_id = MKM's id), identical upsert shape to
 *    app/actions/invoices.ts::applyLineClassification / commitInvoice. Does
 *    NOT set product_id (left NULL — these lines are already ingested with
 *    their own product_id and the price DB is out of scope here) and does
 *    NOT write price_records. SSE/Wessex Water are one-off suppliers for
 *    this package, not a reusable material pattern, so no mapping is written
 *    for those two lines (matches the task's explicit MKM-only scope).
 *
 * SAFETY
 *   Single transaction, rollback on any assertion failure or error.
 *   Idempotent: package lookup is find-or-create by (project_id, code);
 *   funding_line_package_map insert uses the existing unique index on
 *   (funding_budget_line_id, cost_package_id) with ON CONFLICT DO NOTHING;
 *   invoice_line_items updates are guarded WHERE cost_package_id IS NULL;
 *   classification_mappings upserts use the existing partial unique index
 *   (key_kind, key_value, coalesce(supplier_id, 0)).
 *   --dry-run is the DEFAULT. --execute is required to write anything; the
 *   dry run still opens a transaction (to read consistent state) but always
 *   rolls back, never commits.
 *   Never touches: funding_budget_lines, funding_drawdown_events,
 *   funding_drawdown_allocations, invoices.gross/net/vat, needs_review.
 *   No Xero calls of any kind.
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/apply-owner-decisions-2026-08-18.mts [--execute]
 */

import { Pool } from "pg"

const EXECUTE = process.argv.includes("--execute")

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL not set. Run with: npx tsx --env-file=.env.local --env-file=.env.development.local scripts/apply-owner-decisions-2026-08-18.mts",
  )
  process.exit(1)
}

const PROJECT_ID = 1

// --- lib/normalisation/products.ts (reproduced standalone, matching every
// other script in scripts/ — never imported, so drift is visible on re-diff).
const NOISE_PATTERNS: RegExp[] = [
  /\bpriced?\s+from\s+quote\b.*$/i,
  /\bquote\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bq\d{4,}\b/i,
  /\border\s*(?:no\.?|ref\.?|#)?\s*[a-z0-9-]+/i,
  /\bref\.?\s*[:#]?\s*[a-z0-9-]+/i,
]
function normaliseDescriptionKey(description: string): string {
  let s = description ?? ""
  for (const re of NOISE_PATTERNS) s = s.replace(re, " ")
  s = s.replace(/\s+/g, " ").trim().toUpperCase()
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
}

const money = (v: unknown): string => "£" + Number(v ?? 0).toFixed(2)

type Row = Record<string, any>

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()

async function assertEq(label: string, actual: unknown, expected: unknown) {
  // Numeric-string tolerant compare for money columns.
  const a = typeof actual === "string" && !isNaN(Number(actual)) ? Number(actual) : actual
  const e = typeof expected === "string" && !isNaN(Number(expected)) ? Number(expected) : expected
  if (a !== e) {
    throw new Error(`ASSERTION FAILED: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

try {
  await client.query("BEGIN")

  console.log(`Mode: ${EXECUTE ? "EXECUTE (will write)" : "DRY RUN (no writes — pass --execute to apply)"}`)

  // ---------------------------------------------------------------------
  // PRE-FLIGHT ASSERTIONS — abort (rollback, non-zero exit) if any fails.
  // ---------------------------------------------------------------------
  console.log("\n== ASSERTIONS ==")

  const { rows: projRows } = await client.query<Row>("SELECT id, name FROM projects WHERE id = $1", [PROJECT_ID])
  if (projRows.length !== 1) throw new Error(`ASSERTION FAILED: project ${PROJECT_ID} not found`)
  if (!/higher farm/i.test(projRows[0].name)) {
    throw new Error(`ASSERTION FAILED: project ${PROJECT_ID} name is "${projRows[0].name}", expected Higher Farm`)
  }
  console.log(`  OK  project ${PROJECT_ID} = "${projRows[0].name}"`)

  const { rows: pkgRows } = await client.query<Row>(
    "SELECT id, code, name, original_budget FROM cost_packages WHERE project_id = $1 ORDER BY code",
    [PROJECT_ID],
  )
  const pkgByCode = new Map(pkgRows.map((p) => [p.code as string, p]))
  const expectedCodes = Array.from({ length: 21 }, (_, i) => String(i + 1).padStart(2, "0"))
  for (const code of expectedCodes) {
    if (!pkgByCode.has(code)) throw new Error(`ASSERTION FAILED: cost_packages code '${code}' missing for project ${PROJECT_ID}`)
  }
  await assertEq("cost_packages code '20' id", pkgByCode.get("20")!.id, 22)
  await assertEq("cost_packages code '21' id", pkgByCode.get("21")!.id, 23)
  console.log(`  OK  codes '01'..'21' present (21 packages); '20'=id22, '21'=id23 confirmed`)

  const existingPkg22 = pkgByCode.get("22")
  if (existingPkg22) {
    if (existingPkg22.name !== "Utilities & Service Connections" || existingPkg22.original_budget !== null) {
      throw new Error(
        `ASSERTION FAILED: cost_packages code '22' already exists (id ${existingPkg22.id}) but does not match the expected name/NULL budget — refusing to reuse it. Found: ${JSON.stringify(existingPkg22)}`,
      )
    }
    console.log(`  OK  cost_packages code '22' already exists (id ${existingPkg22.id}) and matches expected shape — will reuse, not duplicate`)
  } else {
    console.log(`  OK  cost_packages code '22' does not exist yet — will be created`)
  }

  const drainagePkg = pkgByCode.get("18")
  const groundworksPkg = pkgByCode.get("02")
  if (!drainagePkg || drainagePkg.name !== "Drainage") throw new Error(`ASSERTION FAILED: cost_packages code '18' is not "Drainage" (${JSON.stringify(drainagePkg)})`)
  if (!groundworksPkg || groundworksPkg.name !== "Groundworks & Foundations") {
    throw new Error(`ASSERTION FAILED: cost_packages code '02' is not "Groundworks & Foundations" (${JSON.stringify(groundworksPkg)})`)
  }
  console.log(`  OK  code '18' = "Drainage" (id ${drainagePkg.id}); code '02' = "Groundworks & Foundations" (id ${groundworksPkg.id})`)

  const { rows: lineRows } = await client.query<Row>(
    "SELECT id, description, original_amount FROM funding_budget_lines WHERE id IN (87, 90, 91) ORDER BY id",
  )
  const lineById = new Map(lineRows.map((l) => [l.id as number, l]))
  if (lineById.size !== 3) throw new Error(`ASSERTION FAILED: expected funding_budget_lines 87, 90, 91 to all exist, found ${lineById.size}`)
  await assertEq("line 87 description", lineById.get(87)!.description, "Mains Electricity Supplies and Metering")
  await assertEq("line 87 original_amount", lineById.get(87)!.original_amount, 19089.72)
  await assertEq("line 90 description", lineById.get(90)!.description, "Mains Water Supplies & Metering")
  await assertEq("line 90 original_amount", lineById.get(90)!.original_amount, 6065.00)
  await assertEq("line 91 description", lineById.get(91)!.description, "BT and Broadband")
  await assertEq("line 91 original_amount", lineById.get(91)!.original_amount, 2959.82)
  console.log(`  OK  funding_budget_lines 87/90/91 match verbatim lender descriptions and amounts (untouched, read-only check)`)

  const { rows: inv212 } = await client.query<Row>(
    `SELECT i.id, i.project_id, i.invoice_number, i.gross, s.name AS supplier_name
       FROM invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = 212`,
  )
  if (inv212.length !== 1) throw new Error("ASSERTION FAILED: invoice 212 not found")
  await assertEq("invoice 212 project_id", inv212[0].project_id, PROJECT_ID)
  await assertEq("invoice 212 supplier name", inv212[0].supplier_name, "Scotish and Sothern Electricity Networks")
  await assertEq("invoice 212 invoice_number", inv212[0].invoice_number, ": FGG947/1")
  await assertEq("invoice 212 gross", inv212[0].gross, 19089.72)
  const { rows: lines212 } = await client.query<Row>(
    "SELECT id, description, line_gross, cost_package_id FROM invoice_line_items WHERE invoice_id = 212",
  )
  if (lines212.length !== 1 || lines212[0].id !== 400) throw new Error(`ASSERTION FAILED: invoice 212 expected exactly line 400, found ${JSON.stringify(lines212)}`)
  await assertEq("line 400 line_gross", lines212[0].line_gross, 19089.72)
  console.log(`  OK  invoice 212 (SSE, ': FGG947/1') — single line 400, £19,089.72, matches expected`)

  const { rows: inv211 } = await client.query<Row>(
    `SELECT i.id, i.project_id, i.invoice_number, i.gross, s.name AS supplier_name
       FROM invoices i JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = 211`,
  )
  if (inv211.length !== 1) throw new Error("ASSERTION FAILED: invoice 211 not found")
  await assertEq("invoice 211 project_id", inv211[0].project_id, PROJECT_ID)
  await assertEq("invoice 211 supplier name", inv211[0].supplier_name, "Wessex Water")
  await assertEq("invoice 211 invoice_number", inv211[0].invoice_number, "QS55335")
  await assertEq("invoice 211 gross", inv211[0].gross, 6065.00)
  const { rows: lines211 } = await client.query<Row>(
    "SELECT id, description, line_gross, cost_package_id FROM invoice_line_items WHERE invoice_id = 211",
  )
  if (lines211.length !== 1 || lines211[0].id !== 399) throw new Error(`ASSERTION FAILED: invoice 211 expected exactly line 399, found ${JSON.stringify(lines211)}`)
  await assertEq("line 399 line_gross", lines211[0].line_gross, 6065.00)
  console.log(`  OK  invoice 211 (Wessex Water, 'QS55335') — single line 399, £6,065.00, matches expected`)

  const MKM_DRAINAGE_IDS = [462, 463, 464, 465, 466, 467, 468]
  const MKM_BLOCKWORK_IDS = [456, 457, 458, 459, 460, 461]
  const MKM_ALL_IDS = [...MKM_BLOCKWORK_IDS, ...MKM_DRAINAGE_IDS]
  const { rows: mkmLines } = await client.query<Row>(
    `SELECT li.id, li.description, li.line_gross, li.normalised_unit, li.cost_package_id, li.invoice_id, i.supplier_id, s.name AS supplier_name
       FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id JOIN suppliers s ON s.id = i.supplier_id
      WHERE li.id = ANY($1::int[]) ORDER BY li.id`,
    [MKM_ALL_IDS],
  )
  if (mkmLines.length !== MKM_ALL_IDS.length) {
    throw new Error(`ASSERTION FAILED: expected ${MKM_ALL_IDS.length} MKM line items, found ${mkmLines.length}`)
  }
  const mkmById = new Map(mkmLines.map((l) => [l.id as number, l]))
  const mkmSupplierIds = new Set(mkmLines.map((l) => l.supplier_id))
  if (mkmSupplierIds.size !== 1) throw new Error(`ASSERTION FAILED: MKM lines span more than one supplier: ${JSON.stringify([...mkmSupplierIds])}`)
  const MKM_SUPPLIER_ID = mkmLines[0].supplier_id as number
  if (!/^MKM/i.test(mkmLines[0].supplier_name)) throw new Error(`ASSERTION FAILED: supplier ${MKM_SUPPLIER_ID} is "${mkmLines[0].supplier_name}", expected MKM`)
  for (const id of [467, 468]) {
    const l = mkmById.get(id)!
    if (!(Number(l.line_gross) < 0)) throw new Error(`ASSERTION FAILED: credit line ${id} line_gross is not negative (${l.line_gross})`)
  }
  for (const id of MKM_BLOCKWORK_IDS.concat([462, 463, 464, 465, 466])) {
    const l = mkmById.get(id)!
    if (!(Number(l.line_gross) > 0)) throw new Error(`ASSERTION FAILED: invoice line ${id} line_gross is not positive (${l.line_gross})`)
  }
  console.log(`  OK  ${MKM_ALL_IDS.length} MKM line items found (supplier id ${MKM_SUPPLIER_ID}, "${mkmLines[0].supplier_name}"); credit lines 467/468 confirmed negative`)

  // ---------------------------------------------------------------------
  // CHANGE 1 — new cost package
  // ---------------------------------------------------------------------
  console.log("\n== CHANGE 1: cost package ==")
  let pkg22Id: number
  let pkg22Created = false
  if (existingPkg22) {
    pkg22Id = existingPkg22.id
    console.log(`  cost_packages: reuse existing id ${pkg22Id}, code '22' "Utilities & Service Connections" (project ${PROJECT_ID}, original_budget NULL)`)
  } else if (EXECUTE) {
    const { rows } = await client.query<Row>(
      `INSERT INTO cost_packages (project_id, code, name, original_budget) VALUES ($1, '22', 'Utilities & Service Connections', NULL) RETURNING id`,
      [PROJECT_ID],
    )
    pkg22Id = rows[0].id
    pkg22Created = true
    console.log(`  cost_packages: INSERTED id ${pkg22Id}, code '22' "Utilities & Service Connections" (project ${PROJECT_ID}, original_budget NULL)`)
  } else {
    // Dry run and not yet created — no real id to resolve. Use a placeholder
    // for the rest of the PLAN output only; nothing downstream is written.
    pkg22Id = -1
    pkg22Created = true
    console.log(`  cost_packages: WOULD INSERT code '22' "Utilities & Service Connections" (project ${PROJECT_ID}, original_budget NULL) — id not yet known (dry run)`)
  }

  // ---------------------------------------------------------------------
  // CHANGE 2 — map the three lender lines to it
  // ---------------------------------------------------------------------
  console.log("\n== CHANGE 2: funding_line_package_map ==")
  const MAP_LINES: { id: number; desc: string; amount: string }[] = [
    { id: 87, desc: "Mains Electricity Supplies and Metering", amount: "19089.72" },
    { id: 90, desc: "Mains Water Supplies & Metering", amount: "6065.00" },
    { id: 91, desc: "BT and Broadband", amount: "2959.82" },
  ]
  for (const l of MAP_LINES) {
    if (!pkg22Created) {
      // Package already existed before this run — it's the only case a map
      // row referencing it could already exist too.
      const { rows: existingMap } = await client.query<Row>(
        "SELECT id, weight FROM funding_line_package_map WHERE funding_budget_line_id = $1 AND cost_package_id = $2",
        [l.id, pkg22Id],
      )
      if (existingMap.length > 0) {
        console.log(`  line ${l.id} '${l.desc}' (${money(l.amount)}) -> package 22: already mapped (map id ${existingMap[0].id}, weight ${existingMap[0].weight ?? "NULL"}) — skip`)
        continue
      }
    }
    console.log(`  line ${l.id} '${l.desc}' (${money(l.amount)}) -> package 22, weight NULL (falls back to original-amount-proportion apportionment, matching existing production pattern)`)
    if (EXECUTE) {
      await client.query(
        `INSERT INTO funding_line_package_map (funding_budget_line_id, cost_package_id, weight)
         VALUES ($1, $2, NULL)
         ON CONFLICT (funding_budget_line_id, cost_package_id) DO NOTHING`,
        [l.id, pkg22Id],
      )
    }
  }

  // ---------------------------------------------------------------------
  // CHANGE 3 — classify invoice lines
  // ---------------------------------------------------------------------
  console.log("\n== CHANGE 3: invoice line classification ==")

  type ClassifyTarget = { id: number; supplierName: string; invoiceId: number; amount: string; targetPackageId: number; targetCode: string; targetName: string; learn: boolean }
  const targets: ClassifyTarget[] = [
    { id: 400, supplierName: "Scotish and Sothern Electricity Networks", invoiceId: 212, amount: "19089.72", targetPackageId: pkg22Id, targetCode: "22", targetName: "Utilities & Service Connections", learn: false },
    { id: 399, supplierName: "Wessex Water", invoiceId: 211, amount: "6065.00", targetPackageId: pkg22Id, targetCode: "22", targetName: "Utilities & Service Connections", learn: false },
    ...MKM_DRAINAGE_IDS.map((id) => ({
      id, supplierName: "MKM", invoiceId: mkmById.get(id)!.invoice_id ?? -1, amount: String(mkmById.get(id)!.line_gross),
      targetPackageId: drainagePkg.id, targetCode: "18", targetName: "Drainage", learn: true,
    })),
    ...MKM_BLOCKWORK_IDS.map((id) => ({
      id, supplierName: "MKM", invoiceId: mkmById.get(id)!.invoice_id ?? -1, amount: String(mkmById.get(id)!.line_gross),
      targetPackageId: groundworksPkg.id, targetCode: "02", targetName: "Groundworks & Foundations", learn: true,
    })),
  ]

  let classified = 0
  let alreadyClassified = 0
  for (const t of targets) {
    const { rows: cur } = await client.query<Row>("SELECT cost_package_id, description FROM invoice_line_items WHERE id = $1", [t.id])
    if (cur.length !== 1) throw new Error(`ASSERTION FAILED: line item ${t.id} not found`)
    const before = cur[0].cost_package_id
    const desc = cur[0].description as string
    if (before === t.targetPackageId) {
      alreadyClassified++
      console.log(`  line ${t.id} (invoice ${t.invoiceId}, ${t.supplierName}, ${money(t.amount)}) "${desc.slice(0, 60)}" — already package ${t.targetCode} '${t.targetName}' — skip`)
      continue
    }
    console.log(`  line ${t.id} (invoice ${t.invoiceId}, ${t.supplierName}, ${money(t.amount)}) "${desc.slice(0, 60)}"  ${before ?? "NULL"} -> ${t.targetCode} '${t.targetName}' (id ${t.targetPackageId >= 0 ? t.targetPackageId : "TBD"})`)
    if (EXECUTE) {
      const res = await client.query(
        "UPDATE invoice_line_items SET cost_package_id = $1 WHERE id = $2 AND cost_package_id IS NULL",
        [t.targetPackageId, t.id],
      )
      classified += res.rowCount ?? 0

      if (t.learn) {
        const key = normaliseDescriptionKey(desc)
        if (key) {
          await client.query(
            `INSERT INTO classification_mappings
               (key_kind, key_value, supplier_id, product_id, cost_package_code,
                cost_package_name, category, normalised_unit, times_confirmed)
             VALUES
               ('product', $1, $2, NULL, $3, $4, NULL, $5, 1)
             ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
             DO UPDATE SET
               cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
               cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
               normalised_unit = COALESCE(EXCLUDED.normalised_unit, classification_mappings.normalised_unit),
               times_confirmed = classification_mappings.times_confirmed + 1,
               updated_at = now()`,
            [key, MKM_SUPPLIER_ID, t.targetCode, t.targetName, mkmById.get(t.id)!.normalised_unit ?? null],
          )
        }
      }
    } else if (t.learn) {
      const key = normaliseDescriptionKey(desc)
      console.log(`      -> would upsert classification_mappings (key_kind='product', key='${key}', supplier_id=${MKM_SUPPLIER_ID}, cost_package_code='${t.targetCode}')`)
    }
  }

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  console.log("\n== SUMMARY ==")
  console.log(`  Package: ${pkg22Created ? (EXECUTE ? "created" : "would create") : "reused existing"} code '22' "Utilities & Service Connections"`)
  console.log(`  Funding map rows targeted: 3 (lines 87, 90, 91)`)
  console.log(`  Invoice lines targeted: ${targets.length} (${EXECUTE ? `${classified} updated, ${alreadyClassified} already correct` : "dry run — see plan above"})`)
  console.log(`  Learning upserts: MKM lines only (${MKM_ALL_IDS.length} candidates, supplier id ${MKM_SUPPLIER_ID})`)

  if (!EXECUTE) {
    await client.query("ROLLBACK")
    console.log("\nDRY RUN — nothing written. Re-run with --execute to apply.")
    process.exit(0)
  }

  await client.query("COMMIT")
  console.log("\nCOMMITTED.")
} catch (err) {
  await client.query("ROLLBACK")
  console.error("\nRolled back:", err instanceof Error ? err.message : err)
  process.exit(1)
} finally {
  client.release()
  await pool.end()
}
