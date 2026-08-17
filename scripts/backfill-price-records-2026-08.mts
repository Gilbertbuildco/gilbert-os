/**
 * Backfill the procurement price database (products + price_records) from
 * invoice line items that were committed WITHOUT product/price tracking, AND
 * canonicalise product identity so equivalent commodities from different
 * merchants collapse onto ONE product row (never one row per wording).
 *
 * WHY THIS EXISTS
 *   423 confirmed invoice line items exist; only 84 were price-tracked
 *   (products=68, price_records=82). The bulk text-layer ingest of Bradfords
 *   (338 lines) and the Xero-recovery bill ingests deliberately set
 *   is_price_tracked=false / product_id=NULL on every line (see those
 *   scripts' own headers) — genuine merchant materials never reached the
 *   procurement DB. The owner noticed a concrete example: SureCav Cavity
 *   Spacer System, 8 real Bradfords lines, entirely absent from Gilbert OS.
 *   This script fills that gap for a small, explicit set of merchant
 *   suppliers, following the same product/price shape `commitInvoice` writes
 *   at commit time (`app/actions/invoices.ts`) and the pattern established by
 *   `scripts/ingest-mkm-invoices-2026-08.mts`.
 *
 *   A first pass of this script matched products by exact (normalised) name
 *   only, which the owner flagged: "there should only be one 140 block" —
 *   Bradfords', Travis Perkins' and MKM's wordings for the same physical
 *   commodity would otherwise sit as separate product rows, defeating the
 *   whole point of a comparable cross-supplier price DB. This version adds
 *   an explicit canonicalisation pass (see CANONICALISATION below) BEFORE
 *   product resolution, and also fixes 6 specific already-tracked price
 *   records that were committed with the same pack-unit bug this script
 *   fixes for everything else (see STALE PRICE RECORD CORRECTIONS below).
 *
 * SCOPE — suppliers, not the whole invoice book
 *   ONLY these merchant suppliers, resolved by exact case-insensitive name
 *   against the `suppliers` table (never fuzzy-matched, never created):
 *     "Bradfords Building Supplies Limited", "Travis Perkins", "MKM",
 *     "City plumbing", "Hopkins concrete", "Porcelanosa"
 *   Every other supplier (subcontract/services/professional/plant) is
 *   untouched — this script never even reads their line items. If a named
 *   supplier does not exist in this database (verified empirically:
 *   "Porcelanosa" does not, as of 2026-08), it contributes zero rows and is
 *   reported as such, never treated as an error.
 *   NOTE: canonicalisation itself (matching against the existing 68/69
 *   products to find a reuse target / a pre-existing duplicate family) reads
 *   the WHOLE `products` table regardless of which supplier originally
 *   created each row — that is deliberate and is the entire point (a
 *   Bradfords line and an existing MKM product can be the same commodity).
 *   It never WRITES to any product outside what's described below.
 *
 * QUALIFYING LINE (all of these, from the DB, not assumed):
 *   invoices.status = 'confirmed' AND invoices.transaction_type = 'invoice'
 *   (credits are never price-tracked — matches commitInvoice's own gate; in
 *   practice every one of this script's positive-net candidates already is
 *   an invoice line, since a credit's line_net is stored negative)
 *   AND invoice_line_items.line_net > 0
 *   AND invoice_line_items.is_price_tracked = false
 *   AND invoice_line_items.product_id IS NULL
 *
 * PER-LINE SKIP RULES (checked in this order, first match wins, always
 * reported with a reason — nothing is silently dropped):
 *   1. NON_PRODUCT_PATTERNS from lib/normalisation/products.ts — imported
 *      directly (pure, no server-only guard), not reproduced, so this script
 *      can never drift from the same rule the live enrichment pipeline uses.
 *      Catches delivery/carriage/surcharge/labour/hire/pallet-charge/etc.
 *   2. Discount/promo lines Bradfords marks with a leading "*" or the literal
 *      "Red House Deals" wording (e.g. "*REDHOUSEDEALS - Red House Deals").
 *      These already carry negative line_net in this database and so never
 *      reach the qualifying set via the SQL filter above, but the check is
 *      kept here so a future positive-net promo line is still caught.
 *   3. Bespoke/plot-specific one-off lines — a summary/apportionment line for
 *      a single plot rather than a re-orderable merchant SKU, e.g.
 *      "Plot 1 Windows", "PLOT 2 - GARAGE ABUTMENT", "PLOT 1 - CHIMNEY
 *      SHOULDERS". Detected by a literal "plot <n>" token in the
 *      description — narrow and verifiable, not a guess.
 *   4. Generic statement lines with no product spec at all — verified
 *      examples: a Hopkins Concrete line whose entire description is just
 *      "Concrete" (£12,444.75, no mix/grade/spec — a batch summary line, not
 *      an orderable item) and one whose entire description is just
 *      "Goods/services" (£2,365.50). Matched by exact (trimmed,
 *      case-insensitive) equality against a short, explicit list — never a
 *      broad heuristic that could catch a genuine short product name.
 *   5. Null or zero quantity — line_net / quantity cannot be computed without
 *      fabricating a number, so the whole line is skipped (product_id and
 *      is_price_tracked are left untouched, not just the price record).
 *      All 4 City Plumbing lines in this batch (3 "Rivassa radiators..." and
 *      one "MX Ducostone shower tray etc") were extracted with quantity =
 *      NULL (bundled/summary text, not a line-item quantity) and would hit
 *      this rule — but in practice 3 of the 4 ("Rivassa...") are caught
 *      first by rule 1: each embeds the literal word "delivery" in "delivery
 *      note F74810" etc, which trips NON_PRODUCT_PATTERNS' `\bdelivery\b`.
 *      That is a known false-positive of the SHARED pattern (it means
 *      "delivery note reference", not "this is a delivery charge") — this
 *      script reuses the pattern as-is rather than special-casing it, so
 *      behaviour never drifts from the live pipeline; either way the line is
 *      correctly excluded (it has no usable quantity regardless).
 *
 * PRICE_EX_VAT DERIVATION — the actual bug this script fixes
 *   Bradfords invoices in pack units: "Ten", "hun", "thou", "100m". Their
 *   printed unit_price_ex_vat is PER PACK (e.g. "Concrete Block 7.3n 140mm,
 *   43 Ten, unit_price 18.00, line_net 77.40" — 18.00 is the price of a pack
 *   of ten blocks, not one block). Reading unit_price_ex_vat directly would
 *   overstate the per-item price by 10x/100x/1000x and corrupt the price DB
 *   (non-negotiable #8). Instead this script derives:
 *     price_ex_vat = round4(line_net / quantity)
 *   which is exact for every one of these unit conventions because
 *   `quantity` in this database is always the count of individual items
 *   (verified: 43 individual blocks, £77.40 total → £1.80 each; 432
 *   individual blocks, £529.20 total → £1.225 each) — never a count of
 *   packs. This is arithmetic on two numbers genuinely printed/extracted
 *   on the invoice, not a fabricated figure. Where quantity is null/zero,
 *   the line is skipped entirely (rule 5 above) rather than guessing.
 *
 * UNIT LABELLING ON price_records (never changes quantity/price/totals) —
 * AND NEVER COLLAPSED BY CANONICALISATION (owner's instruction #2)
 *   `price_records.unit` always carries the RAW merchant unit exactly as
 *   already stored on the line item — untouched, immutable.
 *   `price_records.normalised_unit` is the real `normaliseUnit()` from
 *   lib/normalisation/units.ts where it has a confident mapping (ea, EACH,
 *   M2, m, ...). For the 4 Bradfords pack tokens it doesn't recognise (Ten,
 *   hun, thou, 100m), this script applies one small, explicitly-documented,
 *   narrowly-scoped local map (`BRADFORDS_PACK_UNIT_LABEL` below) so the
 *   label matches what price_ex_vat is actually denominated in: quantity is
 *   individual blocks/ties/fixings for Ten/hun/thou → "each"; quantity is
 *   individual metres of reel/bundle stock for 100m → "metre". This is a
 *   *label* only, verified against the reconciling arithmetic above — it is
 *   local to this script (not merged into the shared, cross-supplier
 *   lib/normalisation/units.ts, which is deliberately conservative) and
 *   never changes quantity, price or any total (non-negotiable #9).
 *   PRODUCT IDENTITY MERGES; PRICE RECORDS DO NOT. A block bought "per each"
 *   and a block bought "per m²" are different price points and both stay on
 *   their own price_records row, with their own unit/normalised_unit, all
 *   pointing at the SAME canonical product — that is exactly what makes the
 *   OS able to show both against one product instead of hiding one.
 *
 * CANONICALISATION — one product per real-world commodity, not per wording
 *   Applied BEFORE product resolution, to BOTH the candidate line's
 *   description AND every existing product's name (so this can find and
 *   reuse an existing product that is already a variant of the same
 *   commodity, not just avoid creating new duplicates going forward):
 *     1. Strip certification/reference boilerplate that varies without
 *        changing what the item actually is: "FSC Mix NN%", "NN% PEFC
 *        Certified", "SA-(PEFC-)?COC-\d+", a trailing merchant code
 *        "B\d{6}" (MKM's convention), and "(Per m2)". This alone lets e.g.
 *        MKM's "...100MM B003631" and Bradfords' "...100mm" collapse.
 *     2. Test the stripped text against an explicit, owner-provided set of
 *        canonical-commodity regexes (CANONICAL_RULES below — 9 with an
 *        owner-given canonical name; gaffer tape / line marking paint /
 *        plasterboard adhesive foam were named "merge as in the sheet" but
 *        the sheet itself wasn't available to this script, so those three
 *        canonical NAMES are this script's own best-effort colour/variant-
 *        agnostic label, flagged explicitly in the merge report for the
 *        owner to correct if the actual sheet says something different — the
 *        MERGE GROUPING itself, i.e. which lines collapse together, still
 *        comes directly from the owner's own regex, not a guess).
 *     3. A match assigns a CANON:: key (shared by every wording that matches
 *        the same rule, across every supplier and every existing product).
 *        No match falls back to a NAME:: key = normaliseProductName() of the
 *        stripped text — the pre-canonicalisation behaviour, still de-duped,
 *        just narrower (still prevents literal-wording duplicates).
 *   Existing products are grouped by the SAME key. Where a key has more than
 *   one existing product (a pre-existing duplicate family — e.g. the 100mm
 *   7.3N block already existed as 5 separate product rows across Bradfords,
 *   Travis Perkins and MKM before this script ever ran), the member with the
 *   most price_records is the WINNER (tie-break: lowest id). Every new line
 *   under that key — and only that key — attaches to the winner. The other,
 *   losing, pre-existing members are left completely untouched (name, id,
 *   their own existing price_records — nothing) and are printed as an
 *   explicit "pre-existing duplicate family, not merged" finding for the
 *   owner to decide on separately; actually merging them would mean
 *   repointing OTHER already-tracked line items/price records than the 6
 *   named in item 3 below, which is outside what was asked.
 *   A key with no existing match at all creates exactly ONE new product
 *   (name = the canonical label for CANON:: keys, or the first-seen verbatim
 *   description for NAME:: keys) shared by every line under that key —
 *   never one new product per source wording.
 *
 * STALE PRICE RECORD CORRECTIONS — invoice_line_items 37, 40, 42, 51, 52, 53
 *   These 6 Bradfords lines were already is_price_tracked=true / had a
 *   product_id / had a price_records row BEFORE this script ever ran (from
 *   an earlier manual commit), but their price_records.price_ex_vat is the
 *   SAME pack-unit bug this script fixes for everything else (e.g. line 37,
 *   "Concrete Block 7.3n 140mm", 43 "Ten" @ printed £18.00, line_net £77.40
 *   — the stored price_ex_vat is £18.0000, when quantity(43) × correct
 *   price(£1.80) = £77.40 proves the correct figure). This script recomputes
 *   price_ex_vat/vat_amount/price_inc_vat for exactly these 6 rows using the
 *   same line_net/quantity rule, and repoints product_id (on both the line
 *   item and the price record) at the SAME canonical winner the rest of this
 *   script resolves to, if that differs from what they currently point at.
 *   In this dataset none of the 6 actually need repointing (2 of them — 37,
 *   42 — already point at #23, which independently is the canonical winner
 *   for the 140mm-block family; the other 4 — 40, 51, 52, 53 — aren't
 *   covered by any of the 10 canonical rules at all, so they keep their
 *   existing, already-correct, single-member product). A before/after table
 *   is printed in BOTH modes. Nothing else that is already tracked is read
 *   for writing, or written to, by this script — this is an exact, named
 *   list of 6 invoice_line_items ids, not a heuristic.
 *
 * PRODUCT RESOLUTION — new field shape
 *   New products get the same field shape commitInvoice writes. For a
 *   CANON:: match: name = description = normalisedName = the canonical
 *   label (no single merchant's wording is privileged); dimensions/
 *   thickness are parsed from the canonical label itself. For a NAME::
 *   fallback: name = description = the first-seen verbatim description
 *   (immutable-in-spirit, matches the line item's own audit text);
 *   normalisedName = normaliseProductName() of the boilerplate-stripped
 *   text; dimensions/thickness parsed from the raw description. Either way,
 *   `unit` on the product row is the most common raw unit among the lines
 *   that created it (informational only — real unit history lives on each
 *   price_records row, never lost). category = a learned
 *   classification_mappings row's category IF every line merged into this
 *   product agrees on ONE non-null value — else NULL, never guessed
 *   (non-negotiable #1), and a conflict is reported explicitly rather than
 *   silently picked. productFamily/productType/subcategory are left NULL —
 *   this script does no AI enrichment, so inventing them would be
 *   fabrication.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - No cost-package classification. cost_package_id is never read or
 *     written by this script.
 *   - No classification_mappings writes. There is nothing new being learned
 *     here (category, where used, comes FROM an existing mapping row, never
 *     the other way round) and the task this script serves is product/price
 *     backfill only — writing classification_mappings is a distinct
 *     decision (cost-package assignment) this script does not make.
 *   - No changes to any other supplier's line items, invoices or products.
 *   - No changes to invoice_line_items.unit / raw_unit / description — those
 *     are immutable audit fields; only product_id and is_price_tracked are
 *     ever updated on a line item (plus product_id on the 6 named stale
 *     rows in item 3, if a repoint is actually needed).
 *   - Never renames, merges or deletes an existing product row outright —
 *     "losing" members of a pre-existing duplicate family are left exactly
 *     as they are, just no longer targeted by NEW lines. Consolidating them
 *     for real is a separate decision for the owner.
 *
 * IDEMPOTENCY
 *   The qualifying-line SQL filter (is_price_tracked = false AND product_id
 *   IS NULL) means a line already backfilled (by a prior run of this script,
 *   or normally through the app) is never revisited. Re-running with
 *   --execute after a successful run finds zero qualifying lines and (once
 *   the stored price_ex_vat matches line_net/quantity) zero stale rows to
 *   correct, and writes nothing.
 *
 * SAFETY
 *   --dry-run is the default; it only reads. --execute wraps every write
 *   (product creates, invoice_line_items updates, price_records inserts,
 *   AND the 6 stale-row corrections) in ONE database transaction — if
 *   anything fails partway through, everything rolls back; a partial
 *   backfill is never left behind.
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/backfill-price-records-2026-08.mts [--execute]
 */

import { Pool } from "pg"
import {
  normaliseProductName,
  normaliseDescriptionKey,
  parseDimensions,
  parseThickness,
  suggestTrackPrice,
} from "../lib/normalisation/products.ts"
import { normaliseUnit } from "../lib/normalisation/units.ts"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const EXECUTE = args.includes("--execute")
const DRY_RUN = !EXECUTE

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env.local --env-file=.env.development.local (see file header).")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

const TARGET_SUPPLIERS = [
  "Bradfords Building Supplies Limited",
  "Travis Perkins",
  "MKM",
  "City plumbing",
  "Hopkins concrete",
  "Porcelanosa",
]

// Exact, named list — invoice_line_items.id values, provided by the owner.
// Nothing else already-tracked is ever touched by this script.
const STALE_FIX_LINE_ITEM_IDS = [37, 40, 42, 51, 52, 53]

// ---------------------------------------------------------------------------
// Skip rules 2-4 (rule 1 is the imported NON_PRODUCT_PATTERNS/suggestTrackPrice;
// rule 5, null/zero quantity, is a plain runtime check).
// ---------------------------------------------------------------------------

// Rule 2 — Bradfords' own promo-code convention: lines starting "*" and/or
// containing "Red House Deals". Belt-and-braces: these already carry
// negative line_net in this database and never reach the qualifying set.
const DISCOUNT_PROMO_PATTERNS: RegExp[] = [/^\*/, /\bred\s*house\s*deals\b/i]

// Rule 3 — a literal "plot <n>" token, verified against the actual data:
// "Plot 1 Windows", "PLOT 2 - GARAGE ABUTMENT", "PLOT 1 - CHIMNEY SHOULDERS".
const PLOT_SPECIFIC_PATTERN = /\bplot\s*\d+\b/i

// Rule 4 — exact (trimmed, case-insensitive) match only. Deliberately narrow
// so it can never catch a genuine short product name.
const GENERIC_STATEMENT_EXACT = new Set(["concrete", "goods/services", "goods / services"])

// Rule 5 (unit labelling only, not derivation) — narrowly scoped, documented
// in the file header. NOT part of the shared lib/normalisation/units.ts.
const BRADFORDS_PACK_UNIT_LABEL: Record<string, string> = {
  ten: "each",
  hun: "each",
  thou: "each",
  "100m": "metre",
}

function deriveNormalisedUnit(rawUnit: string | null): string | null {
  const rawKey = (rawUnit ?? "").trim().toLowerCase()
  return normaliseUnit(rawUnit).normalised ?? BRADFORDS_PACK_UNIT_LABEL[rawKey] ?? null
}

type SkipReason =
  | { code: "non_product_pattern"; detail: string }
  | { code: "discount_promo"; detail: string }
  | { code: "plot_specific"; detail: string }
  | { code: "generic_statement"; detail: string }
  | { code: "null_or_zero_quantity"; detail: string }

function classifySkip(description: string, unitPriceExVat: number | null, quantity: number | null): SkipReason | null {
  const desc = description ?? ""
  const track = suggestTrackPrice(desc, unitPriceExVat)
  if (!track.suggested && track.reason.startsWith("Looks like a charge")) {
    return { code: "non_product_pattern", detail: track.reason }
  }
  for (const re of DISCOUNT_PROMO_PATTERNS) {
    if (re.test(desc)) return { code: "discount_promo", detail: "Bradfords discount/promo line, not a purchase." }
  }
  if (PLOT_SPECIFIC_PATTERN.test(desc)) {
    return { code: "plot_specific", detail: "Plot-specific one-off/apportionment line, not a re-orderable merchant SKU." }
  }
  if (GENERIC_STATEMENT_EXACT.has(desc.trim().toLowerCase())) {
    return { code: "generic_statement", detail: "Generic statement line with no product spec — cannot identify what was actually bought." }
  }
  if (quantity == null || quantity === 0) {
    return { code: "null_or_zero_quantity", detail: "quantity is null/zero — cannot derive a per-unit price without fabricating one." }
  }
  return null
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000
}

// ---------------------------------------------------------------------------
// CANONICALISATION — strip boilerplate, then match a canonical-commodity rule
// ---------------------------------------------------------------------------

// Certification/reference boilerplate that varies without changing what the
// item physically is. Order matters (COC before the bare "SA-" prefix would
// leave fragments; kept as separate independent patterns since none overlap).
const BOILERPLATE_PATTERNS: RegExp[] = [
  /\bFSC\s*Mix\s*\d+%\b/gi,
  /\b\d+%\s*PEFC\s*Certified\b/gi,
  /\bSA-(?:PEFC-)?COC-\d+\b/gi,
  /\bB\d{6}\b/g, // MKM trailing product code, e.g. "B003631"
  /\(Per\s*m2\)/gi,
]

function stripCertificationBoilerplate(text: string): string {
  let s = text ?? ""
  for (const re of BOILERPLATE_PATTERNS) s = s.replace(re, " ")
  return s.replace(/\s*-\s*$/, "").replace(/\s{2,}/g, " ").trim()
}

// Owner-provided canonical-commodity rules. `fromSheet: false` = this
// script's own best-effort canonical NAME (grouping regex is still the
// owner's own, verbatim) because the underlying spreadsheet text for that
// name wasn't available here — flagged in the merge report either way.
const CANONICAL_RULES: { pattern: RegExp; name: string; fromSheet: boolean }[] = [
  { pattern: /7\.3n.*(100mm)|100mm.*7\.3n|dense concrete solid 7\.3n block 440 x 215 x 100/i, name: "Concrete Block 7.3N 100mm 440 x 215 (dense/solid, any brand)", fromSheet: true },
  { pattern: /7\.3n.*140|140.*7\.3n/i, name: "Concrete Block 7.3N 140mm 440 x 215 (any brand)", fromSheet: true },
  { pattern: /bs5534.*batten|batten.*bs5534/i, name: "Treated Roofing Batten BS5534 25 x 50mm x 4.8m", fromSheet: true },
  { pattern: /rooftx|breathable roofing membrane/i, name: "Breathable Roofing Membrane 170gsm 1m x 50m", fromSheet: true },
  { pattern: /modula clay double roman/i, name: "Clay Double Roman Tile 445 x 330mm (Chiltern Red)", fromSheet: true },
  { pattern: /square hole airbrick/i, name: "Square Hole Airbrick 215 x 65mm (buff or red)", fromSheet: true },
  { pattern: /(iko enertherm|unilin).*(2400 x 1200 x 25|25mm)/i, name: "PIR Rigid Insulation Board 2400 x 1200 x 25mm (any brand)", fromSheet: true },
  { pattern: /sopretherm|xr4000/i, name: "PIR Insulation Board 1200 x 2400 x 150mm (any brand)", fromSheet: true },
  { pattern: /rockwool flexi/i, name: "Flexible Insulation Slab 1200 x 400 x 50mm (pack of 12)", fromSheet: true },
  { pattern: /gaffer tape/i, name: "Gaffer Tape 50mm x 50m (Pack of 2)", fromSheet: false },
  { pattern: /line marking paint/i, name: "Temporary Line Marking Paint Aerosol 750ml", fromSheet: false },
  { pattern: /plasterboard.*adhesive foam|adhesive foam.*plasterboard/i, name: "Plasterboard Adhesive Foam 750ml", fromSheet: false },
]

function canonicalNameFor(strippedText: string): { name: string; fromSheet: boolean } | null {
  for (const rule of CANONICAL_RULES) {
    if (rule.pattern.test(strippedText)) return { name: rule.name, fromSheet: rule.fromSheet }
  }
  return null
}

/** The single identity key used for BOTH existing products and candidate lines. */
function productKeyFor(text: string): { key: string; canonicalName: string | null; fromSheet: boolean | null } {
  const stripped = stripCertificationBoilerplate(text)
  const canon = canonicalNameFor(stripped)
  if (canon) return { key: `CANON::${canon.name}`, canonicalName: canon.name, fromSheet: canon.fromSheet }
  return { key: `NAME::${normaliseProductName(stripped)}`, canonicalName: null, fromSheet: null }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type QualifyingLine = {
  id: number
  invoiceId: number
  description: string
  quantity: number | null
  unit: string | null
  unitPriceExVat: number | null
  lineNet: number
  vatRate: number
  supplierId: number
  supplierName: string
  projectId: number | null
  invoiceDate: string | null
  invoiceNumber: string | null
  transactionType: string
}

type ExistingProduct = { id: number; name: string; normalisedName: string | null; priceRecordCount: number }

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no DB writes)" : "EXECUTE (will write, inside one transaction)"}`)
  console.log(`Target suppliers: ${TARGET_SUPPLIERS.join(", ")}\n`)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  // --- Resolve target suppliers (exact case-insensitive name; never fuzzy, never created) ---
  const supplierRes = await pool.query(
    `SELECT id, name FROM suppliers WHERE lower(name) = ANY($1)`,
    [TARGET_SUPPLIERS.map((s) => s.toLowerCase())],
  )
  const supplierByLowerName = new Map<string, { id: number; name: string }>()
  for (const r of supplierRes.rows) supplierByLowerName.set(String(r.name).toLowerCase(), { id: Number(r.id), name: r.name })
  console.log("Supplier resolution:")
  for (const name of TARGET_SUPPLIERS) {
    const found = supplierByLowerName.get(name.toLowerCase())
    console.log(`  ${found ? `#${found.id}` : "NOT FOUND"}  ${name}${found ? "" : "  (0 qualifying lines — not an error, just not in this database)"}`)
  }
  const supplierIds = [...supplierByLowerName.values()].map((s) => s.id)
  console.log("")

  if (supplierIds.length === 0) {
    console.log("No target suppliers exist in this database. Nothing to do.")
    await pool.end()
    return
  }

  // --- Before counts (used again after dry run to prove zero writes) ---
  const beforeCounts = await pool.query(
    `SELECT (SELECT count(*) FROM invoices) AS inv,
            (SELECT count(*) FROM invoice_line_items) AS li,
            (SELECT count(*) FROM invoice_line_items WHERE is_price_tracked = true) AS li_tracked,
            (SELECT count(*) FROM invoice_line_items WHERE product_id IS NOT NULL) AS li_with_product,
            (SELECT count(*) FROM products) AS pr,
            (SELECT count(*) FROM price_records) AS prr`,
  )
  console.log(`DB counts BEFORE: ${JSON.stringify(beforeCounts.rows[0])}\n`)

  // --- OUT-OF-SCOPE FINDING, surfaced not fixed here (item 3 below fixes the
  // exact 6 the owner named; this listing is broader, for visibility only —
  // any row NOT in STALE_FIX_LINE_ITEM_IDS is reported but never written). ---
  const existingPackBugRes = await pool.query(
    `SELECT pr.invoice_line_item_id, s.name AS supplier_name, li.description, li.unit, li.quantity, li.line_net, pr.price_ex_vat
     FROM price_records pr
     JOIN invoice_line_items li ON li.id = pr.invoice_line_item_id
     JOIN invoices inv ON inv.id = li.invoice_id
     JOIN suppliers s ON s.id = inv.supplier_id
     WHERE inv.supplier_id = ANY($1)
       AND lower(li.unit) IN ('ten','hun','thou','100m')
       AND li.quantity IS NOT NULL AND li.quantity <> 0
       AND abs(pr.price_ex_vat - (li.line_net / li.quantity)) > 0.01`,
    [supplierIds],
  )
  if (existingPackBugRes.rows.length) {
    console.log(`OUT-OF-SCOPE-LISTING (broader than the 6 named for correction below): ${existingPackBugRes.rows.length} EXISTING price_records rows still carry the raw per-pack price:`)
    for (const r of existingPackBugRes.rows) {
      const correct = Number(r.line_net) / Number(r.quantity)
      const inFixList = STALE_FIX_LINE_ITEM_IDS.includes(Number(r.invoice_line_item_id))
      console.log(
        `  invoice_line_item #${r.invoice_line_item_id} [${r.supplier_name}] "${r.description}" unit="${r.unit}" ` +
          `stored price_ex_vat=£${Number(r.price_ex_vat).toFixed(4)}  should be £${correct.toFixed(4)}` +
          `  ${inFixList ? "-> IN the named fix list below" : "-> NOT in the named fix list, left untouched"}`,
      )
    }
    console.log("")
  }

  // ---------------------------------------------------------------------
  // Build the canonical product-family map from ALL existing products —
  // needed both for resolving NEW lines and for repointing the 6 stale rows.
  // ---------------------------------------------------------------------
  const existingProductsRes = await pool.query(
    `SELECT p.id, p.name, p.normalised_name,
            (SELECT count(*) FROM price_records pr WHERE pr.product_id = p.id) AS prr
     FROM products p ORDER BY p.id`,
  )
  const existingProducts: ExistingProduct[] = existingProductsRes.rows.map((r: any) => ({
    id: Number(r.id),
    name: r.name,
    normalisedName: r.normalised_name,
    priceRecordCount: Number(r.prr),
  }))

  type ProductFamily = { key: string; canonicalName: string | null; members: ExistingProduct[]; winnerId: number }
  const familiesByKey = new Map<string, ProductFamily>()
  for (const p of existingProducts) {
    const { key, canonicalName } = productKeyFor(p.name)
    let fam = familiesByKey.get(key)
    if (!fam) {
      fam = { key, canonicalName, members: [], winnerId: p.id }
      familiesByKey.set(key, fam)
    }
    fam.members.push(p)
  }
  for (const fam of familiesByKey.values()) {
    fam.members.sort((a, b) => (b.priceRecordCount - a.priceRecordCount) || (a.id - b.id))
    fam.winnerId = fam.members[0].id
  }
  const existingKeyToWinnerId = new Map<string, number>()
  for (const fam of familiesByKey.values()) existingKeyToWinnerId.set(fam.key, fam.winnerId)

  const duplicateFamilies = [...familiesByKey.values()].filter((f) => f.members.length > 1)
  if (duplicateFamilies.length) {
    console.log(`--- PRE-EXISTING DUPLICATE PRODUCT FAMILIES (already in the DB before this run, NOT merged, flagged for the owner) ---`)
    for (const fam of duplicateFamilies) {
      const winner = fam.members[0]
      console.log(`  Canonical group: ${fam.canonicalName ?? "(no canonical rule — literal name collision)"}  [key=${fam.key}]`)
      console.log(`    WINNER (new lines route here): #${winner.id} "${winner.name}" (price_records=${winner.priceRecordCount})`)
      for (const m of fam.members.slice(1)) {
        console.log(`    not merged, untouched: #${m.id} "${m.name}" (price_records=${m.priceRecordCount})`)
      }
    }
    console.log("")
  }

  // ---------------------------------------------------------------------
  // Qualifying lines
  // ---------------------------------------------------------------------
  const linesRes = await pool.query(
    `SELECT li.id, li.invoice_id, li.description, li.quantity, li.unit, li.unit_price_ex_vat, li.line_net, li.vat_rate,
            inv.supplier_id, s.name AS supplier_name, inv.project_id, to_char(inv.invoice_date, 'YYYY-MM-DD') AS invoice_date, inv.invoice_number, inv.transaction_type
     FROM invoice_line_items li
     JOIN invoices inv ON inv.id = li.invoice_id
     JOIN suppliers s ON s.id = inv.supplier_id
     WHERE inv.supplier_id = ANY($1)
       AND inv.status = 'confirmed'
       AND inv.transaction_type = 'invoice'
       AND li.line_net > 0
       AND li.is_price_tracked = false
       AND li.product_id IS NULL
     ORDER BY s.name, li.id`,
    [supplierIds],
  )
  const lines: QualifyingLine[] = linesRes.rows.map((r: any) => ({
    id: Number(r.id),
    invoiceId: Number(r.invoice_id),
    description: r.description,
    quantity: r.quantity == null ? null : Number(r.quantity),
    unit: r.unit,
    unitPriceExVat: r.unit_price_ex_vat == null ? null : Number(r.unit_price_ex_vat),
    lineNet: Number(r.line_net),
    vatRate: r.vat_rate == null ? 20 : Number(r.vat_rate),
    supplierId: Number(r.supplier_id),
    supplierName: r.supplier_name,
    projectId: r.project_id == null ? null : Number(r.project_id),
    invoiceDate: r.invoice_date ? String(r.invoice_date).slice(0, 10) : null,
    invoiceNumber: r.invoice_number,
    transactionType: r.transaction_type,
  }))
  console.log(`Qualifying lines (confirmed invoice, line_net>0, not yet price-tracked, no product): ${lines.length}`)

  // --- Per-supplier counts ---
  const perSupplierAll = new Map<string, number>()
  for (const l of lines) perSupplierAll.set(l.supplierName, (perSupplierAll.get(l.supplierName) ?? 0) + 1)
  console.log("Per-supplier qualifying counts:")
  for (const name of TARGET_SUPPLIERS) console.log(`  ${name.padEnd(38)} ${perSupplierAll.get(name) ?? 0}`)
  console.log("")

  // --- Classify: skip vs keep ---
  type Kept = QualifyingLine & { priceExVat: number; normalisedUnit: string | null }
  const kept: Kept[] = []
  const skipped: { line: QualifyingLine; reason: SkipReason }[] = []
  for (const l of lines) {
    const skip = classifySkip(l.description, l.unitPriceExVat, l.quantity)
    if (skip) {
      skipped.push({ line: l, reason: skip })
      continue
    }
    // quantity is guaranteed non-null/non-zero past this point (rule 5 above)
    const priceExVat = round4(l.lineNet / (l.quantity as number))
    const normalisedUnit = deriveNormalisedUnit(l.unit)
    kept.push({ ...l, priceExVat, normalisedUnit })
  }

  console.log(`Lines to skip: ${skipped.length}`)
  const skipByReason = new Map<string, number>()
  for (const s of skipped) skipByReason.set(s.reason.code, (skipByReason.get(s.reason.code) ?? 0) + 1)
  for (const [code, n] of skipByReason) console.log(`  ${code.padEnd(24)} ${n}`)
  console.log("\n--- FULL SKIP LIST ---")
  for (const s of skipped) {
    console.log(
      `  line #${s.line.id} [${s.line.supplierName}] inv ${s.line.invoiceNumber ?? "?"} £${s.line.lineNet.toFixed(2)} — ` +
        `${s.reason.code}: ${s.reason.detail}\n    "${s.line.description}"`,
    )
  }

  console.log(`\nLines to keep (would become price-tracked): ${kept.length}`)

  // ---------------------------------------------------------------------
  // Product resolution — canonicalised, one product per key
  // ---------------------------------------------------------------------

  // Learned category lookup: classification_mappings, key_kind='product',
  // key_value = normaliseDescriptionKey(description), preferring a
  // supplier-specific row over a global (supplier_id NULL) one — same
  // preference order app/actions/enrichment.ts uses for recall.
  const cmRes = await pool.query(
    `SELECT key_value, supplier_id, category, times_confirmed FROM classification_mappings WHERE key_kind = 'product'`,
  )
  type CmRow = { keyValue: string; supplierId: number | null; category: string | null; timesConfirmed: number }
  const cmRows: CmRow[] = cmRes.rows.map((r: any) => ({
    keyValue: r.key_value,
    supplierId: r.supplier_id == null ? null : Number(r.supplier_id),
    category: r.category,
    timesConfirmed: Number(r.times_confirmed),
  }))
  function learnedCategory(description: string, supplierId: number): string | null {
    const key = normaliseDescriptionKey(description)
    const candidates = cmRows.filter((r) => r.keyValue === key && (r.supplierId === supplierId || r.supplierId === null) && r.category)
    if (!candidates.length) return null
    candidates.sort((a, b) => {
      const aSpecific = a.supplierId != null ? 1 : 0
      const bSpecific = b.supplierId != null ? 1 : 0
      if (aSpecific !== bSpecific) return bSpecific - aSpecific
      return b.timesConfirmed - a.timesConfirmed
    })
    return candidates[0].category
  }

  // Pass 1 — group kept lines by canonicalised key.
  type KeyAgg = {
    key: string
    canonicalName: string | null
    fromSheet: boolean | null
    sources: Map<string, { count: number; suppliers: Set<string> }>
    unitCounts: Map<string, number>
    categories: Set<string>
    lineIds: number[]
  }
  const keyAggs = new Map<string, KeyAgg>()
  for (const l of kept) {
    const { key, canonicalName, fromSheet } = productKeyFor(l.description)
    let agg = keyAggs.get(key)
    if (!agg) {
      agg = { key, canonicalName, fromSheet, sources: new Map(), unitCounts: new Map(), categories: new Set(), lineIds: [] }
      keyAggs.set(key, agg)
    }
    const src = agg.sources.get(l.description) ?? { count: 0, suppliers: new Set() }
    src.count++
    src.suppliers.add(l.supplierName)
    agg.sources.set(l.description, src)
    agg.unitCounts.set(l.unit ?? "", (agg.unitCounts.get(l.unit ?? "") ?? 0) + 1)
    const cat = learnedCategory(l.description, l.supplierId)
    if (cat) agg.categories.add(cat)
    agg.lineIds.push(l.id)
  }

  // Pass 2 — resolve each key to an existing winner, or a to-be-created spec.
  type ResolvedKey = {
    action: "match" | "create"
    productId: number | null // set for match
    createName: string | null
    createDescription: string | null
    createUnit: string | null
    createCategory: string | null
    categoryConflict: boolean
  }
  const resolvedByKey = new Map<string, ResolvedKey>()
  for (const agg of keyAggs.values()) {
    const existingWinner = existingKeyToWinnerId.get(agg.key)
    if (existingWinner != null) {
      resolvedByKey.set(agg.key, { action: "match", productId: existingWinner, createName: null, createDescription: null, createUnit: null, createCategory: null, categoryConflict: false })
      continue
    }
    // Most common raw unit among the merged lines (informational on the product row only).
    let bestUnit: string | null = null
    let bestUnitCount = -1
    for (const [u, c] of agg.unitCounts) {
      if (c > bestUnitCount) {
        bestUnit = u || null
        bestUnitCount = c
      }
    }
    const categories = [...agg.categories]
    const category = categories.length === 1 ? categories[0] : null
    const categoryConflict = categories.length > 1
    const firstSourceDesc = [...agg.sources.keys()][0]
    const name = agg.canonicalName ?? firstSourceDesc.trim()
    resolvedByKey.set(agg.key, {
      action: "create",
      productId: null,
      createName: name,
      createDescription: name,
      createUnit: bestUnit,
      createCategory: category,
      categoryConflict,
    })
  }

  // Pass 3 — attach each kept line to its resolved product.
  type PlannedLine = Kept & {
    productAction: "match" | "create"
    productId: number | null
    productKey: string
  }
  const planned: PlannedLine[] = kept.map((l) => {
    const { key } = productKeyFor(l.description)
    const resolved = resolvedByKey.get(key)!
    return { ...l, productAction: resolved.action, productId: resolved.productId, productKey: key }
  })

  const matchCount = planned.filter((p) => p.productAction === "match").length
  const createKeys = [...resolvedByKey.entries()].filter(([, r]) => r.action === "create")
  console.log(`\nProducts: ${matchCount} lines match an existing product, ${createKeys.length} distinct new products to create`)
  console.log(`price_records to insert: ${planned.length} (one per kept line — every kept line is transaction_type='invoice' by the SQL filter)`)

  const categoryConflicts = createKeys.filter(([, r]) => r.categoryConflict)
  const withLearnedCategory = createKeys.filter(([, r]) => r.createCategory != null)
  console.log(`New products getting a category from a learned classification_mappings row: ${withLearnedCategory.length}`)
  console.log(`New products with category left NULL (nothing learned, or conflicting values — never guessed): ${createKeys.length - withLearnedCategory.length}`)
  if (categoryConflicts.length) {
    console.log(`  of which ${categoryConflicts.length} had CONFLICTING learned categories across merged sources — left NULL, flagged:`)
    for (const [key] of categoryConflicts) {
      const agg = keyAggs.get(key)!
      console.log(`    ${key}: ${[...agg.categories].join(" vs ")}`)
    }
  }

  // --- Canonical merge report ---
  console.log("\n--- CANONICAL PRODUCT MERGES THIS RUN ---")
  const reportable = [...keyAggs.values()].filter((agg) => agg.canonicalName != null || agg.sources.size > 1)
  if (!reportable.length) {
    console.log("  (none — every kept line's key was already 1:1 with a single existing product and a single wording)")
  }
  for (const agg of reportable) {
    const resolved = resolvedByKey.get(agg.key)!
    const targetLabel =
      resolved.action === "match"
        ? `EXISTING product #${resolved.productId}`
        : `NEW product "${resolved.createName}"`
    const sheetNote = agg.canonicalName && agg.fromSheet === false ? "  [name NOT from the sheet — this script's own best-effort label, please confirm]" : ""
    console.log(`  ${agg.canonicalName ?? "(generic name match, no canonical rule)"} -> ${targetLabel}${sheetNote}`)
    for (const [desc, src] of agg.sources) {
      console.log(`      ${src.count}x "${desc}"  [${[...src.suppliers].join(", ")}]`)
    }
  }

  // --- Sample derived prices (verification) ---
  console.log("\n--- SAMPLE DERIVED PRICES ---")
  const surecav = planned.filter((p) => /surecav/i.test(p.description))
  console.log(`SureCav lines (${surecav.length}):`)
  for (const p of surecav) {
    console.log(
      `  line #${p.id} inv ${p.invoiceNumber}: qty=${p.quantity} unit=${p.unit} line_net=£${p.lineNet.toFixed(2)} ` +
        `-> price_ex_vat=£${p.priceExVat.toFixed(4)} (unit="${p.unit}" normalised="${p.normalisedUnit}")`,
    )
  }
  const packUnitSamples = planned.filter((p) => ["ten", "hun", "thou", "100m"].includes((p.unit ?? "").toLowerCase()))
  console.log(`\nBradfords pack-unit proof lines (${packUnitSamples.length} — printed unit_price_ex_vat is per PACK, not per item):`)
  for (const p of packUnitSamples.slice(0, 6)) {
    console.log(
      `  line #${p.id} "${p.description}" inv ${p.invoiceNumber}: qty=${p.quantity} unit=${p.unit} ` +
        `printed_unit_price_ex_vat=£${p.unitPriceExVat?.toFixed(2)} line_net=£${p.lineNet.toFixed(2)} ` +
        `-> DERIVED price_ex_vat=£${p.priceExVat.toFixed(4)} each  (NOT £${p.unitPriceExVat?.toFixed(2)})  ` +
        `product=${p.productAction === "match" ? `#${p.productId}` : "NEW"}`,
    )
  }
  console.log("\nAdditional sample derived prices (first 10 kept lines):")
  for (const p of planned.slice(0, 10)) {
    console.log(
      `  line #${p.id} [${p.supplierName}] "${p.description}" qty=${p.quantity} unit=${p.unit} line_net=£${p.lineNet.toFixed(2)} ` +
        `-> price_ex_vat=£${p.priceExVat.toFixed(4)}  product=${p.productAction === "match" ? `#${p.productId}` : "NEW"}`,
    )
  }

  // ---------------------------------------------------------------------
  // Item 3 — the 6 named stale price_records corrections (before/after table
  // printed in BOTH modes; only written in --execute).
  // ---------------------------------------------------------------------
  console.log("\n--- STALE PRICE RECORD CORRECTIONS (named line items only) ---")
  const staleRes = await pool.query(
    `SELECT li.id AS line_item_id, li.description, li.quantity, li.unit, li.line_net, li.vat_rate, li.product_id AS current_product_id,
            pr.id AS price_record_id, pr.price_ex_vat AS old_price_ex_vat, pr.vat_amount AS old_vat_amount,
            pr.price_inc_vat AS old_price_inc_vat, pr.normalised_unit AS old_normalised_unit
     FROM invoice_line_items li
     LEFT JOIN price_records pr ON pr.invoice_line_item_id = li.id
     WHERE li.id = ANY($1) AND li.is_price_tracked = true
     ORDER BY li.id`,
    [STALE_FIX_LINE_ITEM_IDS],
  )
  type StaleCorrection = {
    lineItemId: number
    description: string
    quantity: number
    unit: string | null
    lineNet: number
    vatRate: number
    priceRecordId: number
    oldProductId: number
    newProductId: number
    oldPriceExVat: number
    newPriceExVat: number
    oldVatAmount: number
    newVatAmount: number
    oldPriceIncVat: number
    newPriceIncVat: number
    oldNormalisedUnit: string | null
    newNormalisedUnit: string | null
  }
  const staleCorrections: StaleCorrection[] = []
  const staleWarnings: string[] = []
  const foundIds = new Set(staleRes.rows.map((r: any) => Number(r.line_item_id)))
  for (const id of STALE_FIX_LINE_ITEM_IDS) {
    if (!foundIds.has(id)) staleWarnings.push(`invoice_line_item #${id}: not found, or is_price_tracked is not true — skipped, not touched.`)
  }
  for (const r of staleRes.rows) {
    if (r.price_record_id == null) {
      staleWarnings.push(`invoice_line_item #${r.line_item_id}: is_price_tracked=true but no price_records row found — skipped, not touched.`)
      continue
    }
    const quantity = r.quantity == null ? null : Number(r.quantity)
    if (quantity == null || quantity === 0) {
      staleWarnings.push(`invoice_line_item #${r.line_item_id}: quantity is null/zero — cannot recompute, skipped, not touched.`)
      continue
    }
    const lineNet = Number(r.line_net)
    const vatRate = r.vat_rate == null ? 20 : Number(r.vat_rate)
    const newPriceExVat = round4(lineNet / quantity)
    const newVatAmount = round2(newPriceExVat * (vatRate / 100))
    const newPriceIncVat = round2(newPriceExVat + newVatAmount)
    const newNormalisedUnit = deriveNormalisedUnit(r.unit)
    const { key } = productKeyFor(r.description)
    const newProductId = existingKeyToWinnerId.get(key) ?? Number(r.current_product_id)
    staleCorrections.push({
      lineItemId: Number(r.line_item_id),
      description: r.description,
      quantity,
      unit: r.unit,
      lineNet,
      vatRate,
      priceRecordId: Number(r.price_record_id),
      oldProductId: Number(r.current_product_id),
      newProductId,
      oldPriceExVat: Number(r.old_price_ex_vat),
      newPriceExVat,
      oldVatAmount: r.old_vat_amount == null ? 0 : Number(r.old_vat_amount),
      newVatAmount,
      oldPriceIncVat: r.old_price_inc_vat == null ? 0 : Number(r.old_price_inc_vat),
      newPriceIncVat,
      oldNormalisedUnit: r.old_normalised_unit,
      newNormalisedUnit,
    })
  }
  for (const w of staleWarnings) console.log(`  WARNING: ${w}`)
  console.log(
    `\n  ${"line_item".padEnd(9)} ${"description".padEnd(38)} ${"qty".padEnd(6)} ${"unit".padEnd(5)} ` +
      `${"price_ex_vat before->after".padEnd(28)} ${"vat_amount before->after".padEnd(24)} ${"price_inc_vat before->after".padEnd(26)} ${"normalised_unit before->after".padEnd(24)} product_id before->after`,
  )
  for (const c of staleCorrections) {
    console.log(
      `  #${String(c.lineItemId).padEnd(8)} ${c.description.slice(0, 38).padEnd(38)} ${String(c.quantity).padEnd(6)} ${(c.unit ?? "").padEnd(5)} ` +
        `£${c.oldPriceExVat.toFixed(4)} -> £${c.newPriceExVat.toFixed(4)}`.padEnd(28) + " " +
        `£${c.oldVatAmount.toFixed(4)} -> £${c.newVatAmount.toFixed(4)}`.padEnd(24) + " " +
        `£${c.oldPriceIncVat.toFixed(4)} -> £${c.newPriceIncVat.toFixed(4)}`.padEnd(26) + " " +
        `${c.oldNormalisedUnit ?? "null"} -> ${c.newNormalisedUnit ?? "null"}`.padEnd(24) + " " +
        `#${c.oldProductId} -> #${c.newProductId}${c.oldProductId !== c.newProductId ? "  (REPOINTED)" : "  (no change)"}`,
    )
  }
  if (!staleCorrections.length) console.log("  (nothing to correct)")

  if (DRY_RUN) {
    const afterCounts = await pool.query(
      `SELECT (SELECT count(*) FROM invoices) AS inv,
              (SELECT count(*) FROM invoice_line_items) AS li,
              (SELECT count(*) FROM invoice_line_items WHERE is_price_tracked = true) AS li_tracked,
              (SELECT count(*) FROM invoice_line_items WHERE product_id IS NOT NULL) AS li_with_product,
              (SELECT count(*) FROM products) AS pr,
              (SELECT count(*) FROM price_records) AS prr`,
    )
    console.log(`\nDB counts AFTER (dry run — must equal BEFORE): ${JSON.stringify(afterCounts.rows[0])}`)
    const unchanged = JSON.stringify(beforeCounts.rows[0]) === JSON.stringify(afterCounts.rows[0])
    console.log(unchanged ? "CONFIRMED: zero writes during this dry run." : "WARNING: counts changed during a dry run — investigate before trusting this script.")
    console.log("\nDry run only — nothing written. Re-run with --execute to commit.")
    await pool.end()
    return
  }

  // ---------------------------------------------------------------------
  // Execute: one transaction for the whole run (backfill + stale corrections)
  // ---------------------------------------------------------------------
  console.log("\n--- EXECUTING (single transaction) ---")
  const client = await pool.connect()
  let created = 0
  let matched = 0
  let priceRecordsInserted = 0
  let staleFixed = 0
  try {
    await client.query("BEGIN")

    // --- Item 3: the 6 named stale corrections, exact scope re-checked here too ---
    for (const c of staleCorrections) {
      const recheck = await client.query(
        `SELECT is_price_tracked, product_id FROM invoice_line_items WHERE id = $1`,
        [c.lineItemId],
      )
      if (!recheck.rows.length || recheck.rows[0].is_price_tracked !== true) continue // scope guard, never touch anything else
      await client.query(
        `UPDATE price_records SET product_id = $1, price_ex_vat = $2, vat_amount = $3, price_inc_vat = $4, normalised_unit = $5 WHERE id = $6`,
        [c.newProductId, String(c.newPriceExVat), String(c.newVatAmount), String(c.newPriceIncVat), c.newNormalisedUnit, c.priceRecordId],
      )
      if (c.newProductId !== c.oldProductId) {
        await client.query(`UPDATE invoice_line_items SET product_id = $1 WHERE id = $2`, [c.newProductId, c.lineItemId])
      }
      staleFixed++
    }

    // --- Product creation, keyed by canonicalised key (one product per key) ---
    const createdProductIdByKey = new Map<string, number>()

    for (const p of planned) {
      // Idempotency re-check inside the transaction (defence in depth beyond
      // the SQL filter, matching the two-layer pattern used everywhere else
      // in this codebase).
      const recheck = await client.query(
        `SELECT is_price_tracked, product_id FROM invoice_line_items WHERE id = $1`,
        [p.id],
      )
      if (!recheck.rows.length) continue
      if (recheck.rows[0].is_price_tracked === true || recheck.rows[0].product_id != null) {
        continue // already backfilled since the plan was built — skip, never double-write
      }

      let productId: number | null = null
      if (p.productAction === "match") {
        productId = p.productId
        matched++
      } else {
        const already = createdProductIdByKey.get(p.productKey)
        if (already != null) {
          productId = already
        } else {
          const resolved = resolvedByKey.get(p.productKey)!
          const pname = (resolved.createName ?? p.description).trim()
          // Final race-safety re-check by exact case-insensitive name, same
          // as commitInvoice's own find-or-create.
          const existing = await client.query(`SELECT id FROM products WHERE name ILIKE $1 LIMIT 1`, [pname])
          if (existing.rows[0]) {
            productId = Number(existing.rows[0].id)
          } else {
            const nameSource = resolved.createName ?? p.description
            const insertRes = await client.query(
              `INSERT INTO products (name, description, category, unit, normalised_name, product_family, product_type, dimensions, thickness, subcategory)
               VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,$7,NULL) RETURNING id`,
              [
                pname,
                resolved.createDescription ?? p.description,
                resolved.createCategory,
                resolved.createUnit ?? p.unit,
                normaliseProductName(nameSource),
                parseDimensions(nameSource),
                parseThickness(nameSource),
              ],
            )
            productId = Number(insertRes.rows[0].id)
            created++
          }
          createdProductIdByKey.set(p.productKey, productId)
        }
      }

      await client.query(
        `UPDATE invoice_line_items SET product_id = $1, is_price_tracked = true WHERE id = $2`,
        [productId, p.id],
      )

      const vatAmount = round2(p.priceExVat * (p.vatRate / 100))
      const priceIncVat = round2(p.priceExVat + vatAmount)
      await client.query(
        `INSERT INTO price_records
           (product_id, supplier_id, project_id, invoice_id, invoice_line_item_id,
            price_ex_vat, vat_amount, price_inc_vat, vat_rate, unit, normalised_unit,
            invoice_date, invoice_number, transaction_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'invoice')`,
        [
          productId,
          p.supplierId,
          p.projectId,
          p.invoiceId,
          p.id,
          String(p.priceExVat),
          String(vatAmount),
          String(priceIncVat),
          String(p.vatRate),
          p.unit,
          p.normalisedUnit,
          p.invoiceDate,
          p.invoiceNumber,
        ],
      )
      priceRecordsInserted++
    }

    await client.query("COMMIT")
    console.log(
      `Committed. Stale rows corrected: ${staleFixed}  Products created: ${created}  Products matched (existing): ${matched}  price_records inserted: ${priceRecordsInserted}`,
    )
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    console.error("ERROR — rolled back the entire run, nothing written:", (err as Error).message)
    throw err
  } finally {
    client.release()
  }

  const afterCounts = await pool.query(
    `SELECT (SELECT count(*) FROM invoices) AS inv,
            (SELECT count(*) FROM invoice_line_items) AS li,
            (SELECT count(*) FROM invoice_line_items WHERE is_price_tracked = true) AS li_tracked,
            (SELECT count(*) FROM invoice_line_items WHERE product_id IS NOT NULL) AS li_with_product,
            (SELECT count(*) FROM products) AS pr,
            (SELECT count(*) FROM price_records) AS prr`,
  )
  console.log(`\nDB counts AFTER: ${JSON.stringify(afterCounts.rows[0])}`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
