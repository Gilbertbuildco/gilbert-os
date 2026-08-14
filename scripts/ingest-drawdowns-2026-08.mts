/**
 * Build the Goldentree DRAWDOWN layer (funding_drawdown_events +
 * funding_drawdown_allocations, plus the funding_drawdowns per-line rollup)
 * from the lender's own master matrix, verbatim — never resorting, splitting
 * or rebalancing the immutable `funding_budget_lines` schedule
 * (non-negotiable #2). Also ingests the four lender-paid Target Timber
 * Frames invoices that were never previously in Gilbert OS.
 *
 * --dry-run is the DEFAULT (no flag needed). --execute is required to write
 * anything to Postgres or Blob. In dry-run mode this script makes NO network
 * calls and NO writes anywhere.
 *
 * SOURCE DOCUMENTS (all in /Users/tomgilbert/Downloads/goldentree/)
 *   "3_29.7.26 Stage Cert Paymts & sales record - Gilbert.pdf"  — the master
 *     matrix: 48 funding-line rows x 20 columns (Total Value, 18 drawdown/
 *     payment events, Amount left to draw). See MATRIX/EVENTS below for the
 *     coordinate-reconstruction method (unchanged from the first delivery).
 *   "120_Stage Release Certificate - Foundations.pdf" (Protek, insp. 14 Nov
 *     2025) — corroborates val1_1st_release's timing.
 *   "75_Stage Release Certificate - Timber frame.pdf" (Protek, insp. 24 Feb
 *     2026, issued 26 Feb 2026) — corroborates val3_mip's timing (Xero
 *     receipt 27 Feb 2026).
 *   "2_Stage Release Certificate - Damp Proof Membraine.pdf" (Protek, issued
 *     29 Jul 2026) — corroborates val7_mip's timing (Xero receipt 29 Jul
 *     2026, exact date match).
 *   "93_Gilbert Build Co Ltd  Int6557/58/59/60.pdf" — the four lender-direct-
 *     paid Target Timber Frames invoices (£40,000 / £36,000 / £35,000 /
 *     £1,789.80), addressed "Gilbert Build Co Ltd c/o Goldentree Financial
 *     Services PLC", never previously ingested into Gilbert OS.
 *
 * THE TWO FOOTER ADJUSTMENTS, AS THEIR OWN EVENTS (non-negotiable #1: the
 * original 18 events' certified totals are NEVER altered by these — they are
 * additional, separately-sourced negative events sitting alongside them)
 *   adj_vat_direct_pay (-£560.00)      — "Vat Paid and deducted from next
 *     cert" footer note. No single funding line carries this cleanly (it
 *     spans the Direct Pay x 2 column and a deduction from Val 1) — left
 *     UNALLOCATED (zero allocations), reported, never guessed
 *     (non-negotiable #3).
 *   adj_sanitaryware_cert6 (-£1,000.00) — "Sanitaryware Cert 6 Should not
 *     have been certified" footer note. This ONE has a clean single-line
 *     attribution and gets one allocation of -£1,000.00 against the
 *     Sanitaryware funding line.
 *   Together: £569,178.62 (sum of the 10 borrower-side events) - £560.00 -
 *   £1,000.00 = £567,618.62, EXACTLY the Xero-confirmed total of the 10
 *   Goldentree RECEIVE transactions — the bridge is now preserved verbatim
 *   in the written data, not just in a comment.
 *
 * cash_received MATCHING (coordinator's read-only Xero pull, embedded below
 * as XERO_RECEIPTS — 10 Goldentree Financial RECEIVE bank transactions)
 *   Matched to an event ONLY where the event's own certified_total exactly
 *   equals a receipt amount (single event, single receipt; borrower-side
 *   events only — direct payments never passed through the company bank so
 *   they cannot match a RECEIVE transaction). 7 of 10 receipts match this
 *   way. The remaining 3 (£25,000.00 / £50,342.97 / £54,800.00) do NOT match
 *   any single event's raw certified_total exactly, so cash_received/
 *   received_date stay NULL on val1_1st_release, balance_of_val1 and
 *   val6_mip — reported with the explanation (a "Funds Held Back" footer
 *   split explains the first two; the Sanitaryware correction explains the
 *   third) but never written as if it were an exact match.
 *
 * ITEM 3 — the four Target Timber invoices are ingested with the same
 * four-layer duplicate protection as every other ingest script here
 * (pre-flight DB check, intra-batch guard, in-transaction re-check, the
 * partial unique index invoices_supplier_type_number_uidx as backstop),
 * supplier fixed to the EXISTING "Target Timber Frames" (#16) — never a new
 * supplier — cost_package_code '03' (Superstructure - Frame, same as the
 * existing Int6503), product_id NULL / is_price_tracked false (no
 * price-database write), needs_review true, payment_status 'paid' with an
 * explicit payment_notes flagging the payment never passed through the
 * company's own bank.
 *
 * USAGE
 *   npx tsx --env-file=.env.local --env-file=.env.development.local \
 *     scripts/ingest-drawdowns-2026-08.mts            # dry run (default)
 *   ... scripts/ingest-drawdowns-2026-08.mts --execute # writes + uploads
 */

import { createHash } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { Pool } from "pg"
import { put } from "@vercel/blob"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const EXECUTE = args.includes("--execute")
const DRY_RUN = !EXECUTE

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env.development.local (see file header).")
  process.exit(1)
}
if (EXECUTE && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set — required for --execute (source PDFs must be retained in Blob).")
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const PROJECT_ID = 1
const GOLDENTREE_DIR = "/Users/tomgilbert/Downloads/goldentree"
const MASTER_MATRIX_FILE = "3_29.7.26 Stage Cert Paymts & sales record - Gilbert.pdf"
const MASTER_MATRIX_PATH = path.join(GOLDENTREE_DIR, MASTER_MATRIX_FILE)
const STAGE_CERT_FOUNDATIONS_PATH = path.join(GOLDENTREE_DIR, "120_Stage Release Certificate - Foundations.pdf")
const STAGE_CERT_TIMBER_FRAME_PATH = path.join(GOLDENTREE_DIR, "75_Stage Release Certificate - Timber frame.pdf")
const STAGE_CERT_DPM_PATH = path.join(GOLDENTREE_DIR, "2_Stage Release Certificate - Damp Proof Membraine.pdf")

const gbp = (v: number | null | undefined) =>
  v == null ? "—" : "£" + v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const round2 = (n: number) => Math.round(n * 100) / 100

// ---------------------------------------------------------------------------
// 1) THE RECONSTRUCTED MATRIX — unchanged from the first delivery. Verbatim,
//    one row per funding line, in the lender's original order (position
//    0..47). See handover/first-delivery notes for the coordinate-
//    reconstruction method; this data has already been verified: every row
//    reconciles to the penny and every column total matches the PDF's own
//    "Total" row.
// ---------------------------------------------------------------------------

type EventKey =
  | "protek_warranty"
  | "utilities"
  | "direct_pay_x2"
  | "timber_frame"
  | "val1_1st_release"
  | "balance_of_val1"
  | "val2_mip"
  | "target_timber_systems_1"
  | "reimburse_planning_fees"
  | "reimburse_design_fees"
  | "target_timber_systems_2"
  | "target_timber_systems_3"
  | "val3_mip"
  | "target_timber_systems_4"
  | "val4_mip"
  | "val5_mip"
  | "val6_mip"
  | "val7_mip"

type AdjustmentEventKey = "adj_vat_direct_pay" | "adj_sanitaryware_cert6"

type MatrixRow = {
  description: string
  originalAmount: number
  amountLeftToDraw: number
  events: Partial<Record<EventKey, number>>
}

const MATRIX: MatrixRow[] = [
  { description: "Preliminaries", originalAmount: 10108, amountLeftToDraw: 3608, events: { val1_1st_release: 1500, val2_mip: 1000, val6_mip: 3000, val7_mip: 1000 } },
  { description: "Plot Drainage (Below Ground)", originalAmount: 24800, amountLeftToDraw: 0, events: { val1_1st_release: 24800 } },
  { description: "Foundations", originalAmount: 49602.97, amountLeftToDraw: 0, events: { val1_1st_release: 49602.97 } },
  { description: "Ground Floor Block and Beam", originalAmount: 22000, amountLeftToDraw: 0, events: { val2_mip: 20900, val3_mip: 1100 } },
  { description: "Sub Structure Brickwork", originalAmount: 25000, amountLeftToDraw: 0, events: { val2_mip: 25000 } },
  { description: "Superstructure Brickwork/Timber frame and roof structure", originalAmount: 227000, amountLeftToDraw: 18843, events: { timber_frame: 10367.2, target_timber_systems_1: 40000, target_timber_systems_2: 36000, target_timber_systems_3: 35000, val3_mip: 55000, target_timber_systems_4: 1789.8, val5_mip: 5000, val6_mip: 25000 } },
  { description: "Intermediate Floors (Included in super structure)", originalAmount: 0, amountLeftToDraw: 0, events: {} },
  { description: "Roof Structure", originalAmount: 27000, amountLeftToDraw: 0, events: { val3_mip: 27000 } },
  { description: "Roof Coverings, Valleys/Box Gutters & Flashings", originalAmount: 32576.25, amountLeftToDraw: 9658.89, events: { val3_mip: 21417.36, val7_mip: 1500 } },
  { description: "Fascias, Soffits and RwG", originalAmount: 10258.48, amountLeftToDraw: 3758.48, events: { val4_mip: 6500 } },
  { description: "Windows", originalAmount: 56427.65, amountLeftToDraw: 2427.65, events: { val4_mip: 54000 } },
  { description: "External Door", originalAmount: 20323.23, amountLeftToDraw: 7323.23, events: { val4_mip: 13000 } },
  { description: "Insulation (to studwork/framing and loft)", originalAmount: 25767.62, amountLeftToDraw: 0, events: { val5_mip: 21902.47, val6_mip: 2800, val7_mip: 1065.15 } },
  { description: "Plastering", originalAmount: 36799.75, amountLeftToDraw: 0, events: { val5_mip: 12879.91, val6_mip: 18000, val7_mip: 5919.84 } },
  { description: "First Fix Electrical", originalAmount: 33582, amountLeftToDraw: 0, events: { val4_mip: 23507.4, val5_mip: 10074.6 } },
  { description: "Second Fix Electrical (Included in", originalAmount: 0, amountLeftToDraw: 0, events: {} },
  { description: "First Fix Plumbing", originalAmount: 40848.35, amountLeftToDraw: 0, events: { val4_mip: 13479.95, val5_mip: 27368.4 } },
  { description: "Second Fix Plumbing", originalAmount: 14329.92, amountLeftToDraw: 9329.92, events: { val7_mip: 5000 } },
  { description: "Gas Central Heating (Boiler and Radiators).", originalAmount: 8206.78, amountLeftToDraw: 8206.78, events: {} },
  { description: "First Fix Joinery (studwork and Door Frames etc.)", originalAmount: 15788.57, amountLeftToDraw: 0, events: { val4_mip: 15788.57 } },
  { description: "Second Fix Joinery (Stairs, Skirtings, Architraves, Cills, Internal door and Ironmongery)", originalAmount: 44106.89, amountLeftToDraw: 41606.89, events: { val7_mip: 2500 } },
  { description: "Internal Doors & Ironmongery", originalAmount: 4787.29, amountLeftToDraw: 4787.29, events: {} },
  { description: "Kitchen Cabinets & Worktops", originalAmount: 60788.81, amountLeftToDraw: 60788.81, events: {} },
  { description: "Appliances", originalAmount: 11838.99, amountLeftToDraw: 11838.99, events: {} },
  { description: "Tiling & Splashbacks (kitchen, Bathroom, En-Suite WC ect)", originalAmount: 19371.93, amountLeftToDraw: 19371.93, events: {} },
  { description: "Sanitaryware (including shower trays, vanity and taps etc)", originalAmount: 10463.65, amountLeftToDraw: 4463.65, events: { val6_mip: 1000, val7_mip: 5000 } },
  { description: "Internal Decoration", originalAmount: 27309.41, amountLeftToDraw: 9309.41, events: { val6_mip: 6000, val7_mip: 12000 } },
  { description: "Floorcoverings Tiling & Splashbacks (Kitchen, Bathroom, En-Suite, WC etc)", originalAmount: 17309.41, amountLeftToDraw: 12309.41, events: { val7_mip: 5000 } },
  { description: "Garages & Outbuildings (included in main build costs)", originalAmount: 0, amountLeftToDraw: 0, events: {} },
  { description: "Hard Landscaping (Pavings, Driveways and Patios etc)", originalAmount: 12325.65, amountLeftToDraw: 12325.65, events: {} },
  { description: "Soft Landscaping", originalAmount: 6772.3, amountLeftToDraw: 6772.3, events: {} },
  { description: "Boundaries (Walls, Fencing and Gates)", originalAmount: 18431.3, amountLeftToDraw: 18431.3, events: {} },
  { description: "Adoptable Highway - Construction Cost", originalAmount: 26032.89, amountLeftToDraw: 26032.89, events: {} },
  { description: "Street Lighting - Construction Cost", originalAmount: 6042.46, amountLeftToDraw: 6042.46, events: {} },
  { description: "Mains Electricity Supplies and Metering", originalAmount: 19089.72, amountLeftToDraw: 0, events: { utilities: 19089.72 } },
  { description: "Air/Ground Source Heat Pump", originalAmount: 15000, amountLeftToDraw: 15000, events: {} },
  { description: "Solar Panels", originalAmount: 14799.09, amountLeftToDraw: 14799.09, events: {} },
  { description: "Mains Water Supplies & Metering", originalAmount: 6065, amountLeftToDraw: 0, events: { utilities: 6065 } },
  { description: "BT and Broadband", originalAmount: 2959.82, amountLeftToDraw: 2959.82, events: {} },
  { description: "Septic Tank", originalAmount: 15866.06, amountLeftToDraw: 15866.06, events: {} },
  { description: "Contingency", originalAmount: 58437, amountLeftToDraw: 33437, events: { val7_mip: 25000 } },
  { description: "Planning Application Fees", originalAmount: 5000, amountLeftToDraw: 0, events: { reimburse_planning_fees: 5000 } },
  { description: "Building Regulations Fees", originalAmount: 3602.02, amountLeftToDraw: 802.02, events: { direct_pay_x2: 2800 } },
  { description: "SAP & EPC Fees", originalAmount: 2000, amountLeftToDraw: 2000, events: {} },
  { description: "Architect", originalAmount: 6894.71, amountLeftToDraw: 22.71, events: { reimburse_planning_fees: 6872 } },
  { description: "Insurances", originalAmount: 5510, amountLeftToDraw: 5.04, events: { direct_pay_x2: 5504.96 } },
  { description: "Structural Engineer", originalAmount: 6826.31, amountLeftToDraw: 126.31, events: { reimburse_design_fees: 6700 } },
  { description: "Third Party Home Warranty or PCC", originalAmount: 16544.67, amountLeftToDraw: 0.67, events: { protek_warranty: 16544 } },
]

// ---------------------------------------------------------------------------
// 2) EVENT METADATA — unchanged from the first delivery (18 events).
// ---------------------------------------------------------------------------

type EventMeta = {
  key: EventKey
  label: string
  directPayment: boolean
  eventDate: string | null
  notes: string
}

const EVENTS: EventMeta[] = [
  { key: "protek_warranty", label: "Protek Warranty", directPayment: true, eventDate: null,
    notes: "Warranty premium paid direct to Protek Group Ltd. Loan opening statement (149_Opening Statement.pdf) records a ledger entry '05/11/2025 Protek Group Ltd (re Warranty) £16,554.00' — NOTE this is £10.00 more than this event's matrix total (£16,544.00, which matches the Third Party Home Warranty or PCC funding line exactly). Flagged, not reconciled — do not force either figure." },
  { key: "utilities", label: "Utilities", directPayment: true, eventDate: null,
    notes: "Two utility-supply direct payments, both already present in Gilbert OS as confirmed invoices, payment_status='paid': Wessex Water QS55335 £6,065.00 (invoice_date 2025-09-17) + Scottish & Southern Electricity Networks FGG947/1 £19,089.72 (invoice_date 2025-10-05) = £25,154.72, exact match to this event's certified total. Flag for the owner: these show 'paid' in Gilbert OS but were funded by a lender direct payment, not from the company's own account — worth reviewing payment_status semantics." },
  { key: "direct_pay_x2", label: "Direct Pay x 2", directPayment: true, eventDate: null,
    notes: "Two direct payments against professional-fee lines: Building Regulations Fees £2,800.00 (no matching Gilbert OS invoice found) + Insurances £5,504.96 (Howden Insurance invoice 548259561, invoice_date 2025-09-09, already in Gilbert OS, payment_status='paid' — same lender-paid-but-marked-paid pattern as Utilities above)." },
  { key: "timber_frame", label: "Timber Frame", directPayment: true, eventDate: "2025-11-04",
    notes: "Target Timber Frames invoice Int6503, £10,367.20 — already in Gilbert OS (invoice id 218), invoice_date 2025-11-04, payment_status='paid'. This is the item the task brief called out explicitly: it is IN Gilbert OS marked paid, but the source PDF confirms Goldentree paid it directly to Target Timber, addressed 'Gilbert Build Co Ltd c/o Goldentree Financial Services PLC'. event_date is the invoice date, not a confirmed lender-payment date. Source doc reused from invoice #218's own Blob upload (no duplicate upload)." },
  { key: "val1_1st_release", label: "1st release Val 1", directPayment: false, eventDate: null,
    notes: "Released to the borrower. A dated interim schedule snapshot (125_Gilbert Build Co Limited - Costings - 24.11.2025.pdf) already shows this event fully drawn with Val 2..7 still at zero, so it occurred on or before 24 Nov 2025. cash_received: the raw certified total (£75,902.97) does NOT exactly match any single Xero receipt, so left NULL per the matching rule — but the master matrix's own 'Amount to Borrower' footer row splits it as £25,000.00 (received 2025-11-21, Xero 'b7ccae08...', described '1st drawdown from Goldentree – development loan') + a further £50,342.97 released as 'Drawdown 1' on 2025-11-24 after a 'Funds Held Back' hold — together summing to £75,902.97 exactly. See balance_of_val1 and the adjustment-events section of the report; NOT written to cash_received on this event because it is not a single exact match." },
  { key: "balance_of_val1", label: "Balance of Val 1", directPayment: false, eventDate: null,
    notes: "Certified total is £0.00 across all 48 lines — Val 1 was released in full in one payment; no separate balance was ever drawn under this column. Row created for structural completeness/audit. See val1_1st_release's note: the master matrix's 'Funds Held Back' footer adjustment (-£50,342.97) reclassifies exactly that amount from the Val 1 column into this column in the 'Amount to Borrower' view, and Xero shows a matching £50,342.97 RECEIVE on 2025-11-24 ('Drawdown 1') — not written to cash_received here either, since it is a footer-level reclassification, not this event's own certified figure." },
  { key: "val2_mip", label: "Val 2 (MIP)", directPayment: false, eventDate: null,
    notes: "Released to the borrower. Exact Xero match: £46,900.00 received 2025-12-17 ('Drawdown 2'). A dated snapshot (117_Gilbert Build Co. Ltd - Costings - 17.12.2025.pdf) independently corroborates this event being drawn by that date." },
  { key: "target_timber_systems_1", label: "Target Timber Systems", directPayment: true, eventDate: "2026-01-13",
    notes: "Target Timber Frames invoice Int6557, £40,000.00, invoice dated 13.01.26, payment due 19.01.26, addressed to 'Gilbert Build Co Ltd c/o Goldentree Financial Services PLC'. Ingested into Gilbert OS invoices by this script (see section on Target Timber invoice ingestion) — its Blob upload is reused as this event's source document." },
  { key: "reimburse_planning_fees", label: "Reimburse Planning Fees", directPayment: false, eventDate: null,
    notes: "Reimbursed to the borrower against Planning Application Fees (£5,000.00) and Architect (£6,872.00) = £11,872.00. Exact Xero match: £11,872.00 received 2026-02-04, described 'Architect and planning'." },
  { key: "reimburse_design_fees", label: "Reimburse Design Fees", directPayment: false, eventDate: null,
    notes: "Reimbursed to the borrower against Structural Engineer, £6,700.00. Exact Xero match: £6,700.00 received 2026-02-03, described 'Engineer drawdown'." },
  { key: "target_timber_systems_2", label: "Target Timber Systems", directPayment: true, eventDate: "2026-01-13",
    notes: "Target Timber Frames invoice Int6558, £36,000.00, invoice dated 13.01.26, payment due working day 5 (06.02.26). Ingested into Gilbert OS invoices by this script; Blob upload reused as this event's source document." },
  { key: "target_timber_systems_3", label: "Target Timber Systems", directPayment: true, eventDate: "2026-01-13",
    notes: "Target Timber Frames invoice Int6559, £35,000.00, invoice dated 13.01.26, payment due working day 10 (13.02.26). Ingested into Gilbert OS invoices by this script; Blob upload reused as this event's source document." },
  { key: "val3_mip", label: "Val 3 (MIP)", directPayment: false, eventDate: null,
    notes: "Released to the borrower. Exact Xero match: £104,517.36 received 2026-02-27 ('Drawdown 3'). Corroborated by 75_Stage Release Certificate - Timber frame.pdf (Protek inspection 24 Feb 2026, issued 26 Feb 2026, 'Timber frame erected') — 1-3 days before the receipt; that stage cert's Blob upload is referenced in this event's notes as corroborating evidence, source_file_name stays the master matrix (which supplies the £ figure)." },
  { key: "target_timber_systems_4", label: "Target Timber Systems", directPayment: true, eventDate: "2026-01-13",
    notes: "Target Timber Frames invoice Int6560, £1,789.80, invoice dated 13.01.26, described as 'Balance of agreed total quotation amount', payment due upon TF completion (23.02.26). Ingested into Gilbert OS invoices by this script; Blob upload reused as this event's source document. Together, Int6557+6558+6559+6560 = £112,789.80, plus the earlier Int6503 £10,367.20 = £123,157.00 total Target Timber direct payments across the project." },
  { key: "val4_mip", label: "Val 4 (MIP)", directPayment: false, eventDate: null,
    notes: "Released to the borrower. Exact Xero match: £126,275.92 received 2026-04-17 ('Drawdown 4')." },
  { key: "val5_mip", label: "Val 5 (MIP)", directPayment: false, eventDate: null,
    notes: "Released to the borrower. Exact Xero match: £77,225.38 received 2026-05-22 (described 'Drawdown 2' in Xero — a label reuse/typo on the lender's side; the amount is unambiguous)." },
  { key: "val6_mip", label: "Val 6 (MIP)", directPayment: false, eventDate: null,
    notes: "Released to the borrower. Raw certified total £55,800.00 does NOT exactly match any Xero receipt, so cash_received stays NULL on this event per the matching rule — BUT £55,800.00 minus the adj_sanitaryware_cert6 correction (-£1,000.00, its own event, see below) = £54,800.00 exactly, which matches the Xero RECEIVE on 2026-06-26 (described 'Drawdown'). The correction is written as its own separate, clearly-labelled event/allocation rather than silently changing this event's certified_total (non-negotiable #1)." },
  { key: "val7_mip", label: "Val 7 (MIP)", directPayment: false, eventDate: null,
    notes: "Released to the borrower. Exact Xero match: £63,984.99 received 2026-07-29 ('Drawdown 7'). Corroborated by 2_Stage Release Certificate - Damp Proof Membraine.pdf, issued 29 Jul 2026 — same date as the receipt exactly; that stage cert's Blob upload is referenced in this event's notes as corroborating evidence." },
]

// ---------------------------------------------------------------------------
// 3) ADJUSTMENT EVENTS — the two footer notes below the master matrix's own
//    "Total" row, written as their own events per the coordinator's request,
//    so the £569,178.62 -> £567,618.62 bridge exists in written data, not
//    just narrative. Neither touches any of the 18 events above.
// ---------------------------------------------------------------------------

type AdjustmentEvent = {
  key: AdjustmentEventKey
  label: string
  certifiedTotal: number
  directPayment: boolean
  eventDate: string | null
  notes: string
  allocations: { lineDescription: string; amount: number }[]
}

const ADJUSTMENT_EVENTS: AdjustmentEvent[] = [
  {
    key: "adj_vat_direct_pay",
    label: "Vat Paid and deducted from next cert",
    certifiedTotal: -560.0,
    directPayment: false,
    eventDate: null,
    notes:
      "Footer note on the master matrix, below its own 'Total' row: £560.00 VAT was paid alongside the " +
      "'Direct Pay x 2' column (Building Regulations Fees + Insurances) and the same £560.00 was then " +
      "deducted from the next valuation certificate. No single funding line carries this cleanly (it spans " +
      "two areas of the schedule) — left with ZERO allocations rather than guessed which line to attribute " +
      "it to (non-negotiable #3, UNRESOLVED stays UNRESOLVED). Recorded here purely as a project-level " +
      "correction so the borrower-drawdown total reconciles to the Xero-confirmed figure.",
    allocations: [],
  },
  {
    key: "adj_sanitaryware_cert6",
    label: "Sanitaryware Cert 6 Should not have been certified",
    certifiedTotal: -1000.0,
    directPayment: false,
    eventDate: null,
    notes:
      "Footer correction on the master matrix: £1,000.00 originally certified against the Sanitaryware line " +
      "under Val 6 (MIP) should not have been certified; the matrix moves it back into that line's 'Amount " +
      "left to draw'. val6_mip's own certified_total is left UNCHANGED at £55,800.00 (verbatim, " +
      "non-negotiable #1) — this correction is the mechanism that actually reduces net cash drawn to " +
      "£54,800.00, matching the Xero RECEIVE on 2026-06-26 exactly.",
    allocations: [{ lineDescription: "Sanitaryware (including shower trays, vanity and taps etc)", amount: -1000.0 }],
  },
]

// ---------------------------------------------------------------------------
// 4) XERO RECEIPTS — the coordinator's read-only pull of the 10 Goldentree
//    Financial RECEIVE bank transactions, embedded verbatim (date, amount,
//    description, Xero BankTransactionID) from
//    /private/tmp/claude-501/.../scratchpad/xero-bank.json (pulledAt
//    2026-08-13T12:42:24.561Z). Not re-fetched at runtime — this script has
//    no Xero API access of its own.
// ---------------------------------------------------------------------------

type XeroReceipt = { date: string; amount: number; description: string; bankTransactionId: string }

const XERO_RECEIPTS: XeroReceipt[] = [
  { date: "2025-11-21", amount: 25000.0, description: "1st drawdown from Goldentree – development loan", bankTransactionId: "b7ccae08-3d04-4294-86c8-cf68d3badcbf" },
  { date: "2025-11-24", amount: 50342.97, description: "Drawdown 1", bankTransactionId: "36189943-59d1-4105-b721-6e29417f9ba2" },
  { date: "2025-12-17", amount: 46900.0, description: "Drawdown 2", bankTransactionId: "8897eb00-7fea-4f55-a241-c883a7e4366a" },
  { date: "2026-02-03", amount: 6700.0, description: "Engineer drawdown", bankTransactionId: "7f88d4e2-a7e7-45c3-9bdd-496780ea9c4a" },
  { date: "2026-02-04", amount: 11872.0, description: "Architect and planning", bankTransactionId: "8681d2f3-a991-439a-8375-8f36c3c6ae60" },
  { date: "2026-02-27", amount: 104517.36, description: "Drawdown 3", bankTransactionId: "73b1ad60-d7f9-4bc3-989e-4b8d83975f90" },
  { date: "2026-04-17", amount: 126275.92, description: "Drawdown 4", bankTransactionId: "af79c962-2ab3-429a-9dea-7ffbd6be2b63" },
  { date: "2026-05-22", amount: 77225.38, description: "Drawdown 2", bankTransactionId: "1551b1e5-b291-486e-88d7-1d1d92e4a396" },
  { date: "2026-06-26", amount: 54800.0, description: "Drawdown", bankTransactionId: "04f393b7-af4f-4d6c-a96c-cb65a583fbba" },
  { date: "2026-07-29", amount: 63984.99, description: "Drawdown 7", bankTransactionId: "8ee801b8-7700-4beb-a64e-f799d7d4b10f" },
]

// ---------------------------------------------------------------------------
// 5) TARGET TIMBER INVOICES TO INGEST (item 3) — verbatim from the source
//    PDFs, never previously in Gilbert OS.
// ---------------------------------------------------------------------------

type TargetTimberInvoice = {
  invoiceNumber: string
  invoiceDate: string
  net: number
  vat: number
  gross: number
  description: string
  filePath: string
  dueNote: string
  eventKey: EventKey
}

const TARGET_TIMBER_INVOICES: TargetTimberInvoice[] = [
  {
    invoiceNumber: "Int6557", invoiceDate: "2026-01-13", net: 40000.0, vat: 0, gross: 40000.0,
    description: "Interim", filePath: path.join(GOLDENTREE_DIR, "93_Gilbert Build Co Ltd  Int6557.pdf"),
    dueNote: "Payment due 14 days before delivery 19.01.26", eventKey: "target_timber_systems_1",
  },
  {
    invoiceNumber: "Int6558", invoiceDate: "2026-01-13", net: 36000.0, vat: 0, gross: 36000.0,
    description: "Interim", filePath: path.join(GOLDENTREE_DIR, "93_Gilbert Build Co Ltd  Int6558.pdf"),
    dueNote: "Payment due working day 5 06.02.26", eventKey: "target_timber_systems_2",
  },
  {
    invoiceNumber: "Int6559", invoiceDate: "2026-01-13", net: 35000.0, vat: 0, gross: 35000.0,
    description: "Interim", filePath: path.join(GOLDENTREE_DIR, "93_Gilbert Build Co Ltd  Int6559.pdf"),
    dueNote: "Payment due working day 10 13.02.26", eventKey: "target_timber_systems_3",
  },
  {
    invoiceNumber: "Int6560", invoiceDate: "2026-01-13", net: 1789.8, vat: 0, gross: 1789.8,
    description: "Balance of agreed total quotation amount", filePath: path.join(GOLDENTREE_DIR, "93_Gilbert Build Co Ltd  Int6560.pdf"),
    dueNote: "Payment due upon tf completion 23.02.26", eventKey: "target_timber_systems_4",
  },
]
const TARGET_TIMBER_SUPPLIER_ID = 16 // existing "Target Timber Frames" — never a new supplier
const TARGET_TIMBER_COST_PACKAGE_CODE = "03" // Superstructure - Frame, same as existing Int6503
const TARGET_TIMBER_PAYMENT_NOTES =
  "Paid directly by Goldentree Development Finance (drawdown direct payment) — never through the company bank"

function normaliseDocNumber(raw: string | null | undefined): string {
  if (!raw) return ""
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").trim()
}
function normaliseSupplierName(raw: string | null | undefined): string {
  if (!raw) return ""
  let s = raw.toLowerCase()
  s = s.replace(/&/g, " and ")
  s = s.replace(/[^a-z0-9\s]/g, " ")
  const stopWords = new Set(["ltd", "limited", "plc", "llp", "llc", "inc", "incorporated", "co", "company", "group", "holdings", "uk", "the"])
  s = s.split(/\s+/).filter((w) => w && !stopWords.has(w)).join(" ")
  return s.trim()
}
function normaliseDescriptionKey(description: string): string {
  return description.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
}

// ---------------------------------------------------------------------------
// 6) Compute events (certified totals) + allocations from MATRIX.
// ---------------------------------------------------------------------------

type ComputedEvent = EventMeta & { certifiedTotal: number }
type ComputedAllocation = { eventKey: EventKey | AdjustmentEventKey; lineIndex: number; amount: number }

const computedEvents: ComputedEvent[] = EVENTS.map((e) => {
  const total = round2(MATRIX.reduce((sum, row) => sum + (row.events[e.key] ?? 0), 0))
  return { ...e, certifiedTotal: total }
})

const allocations: ComputedAllocation[] = []
MATRIX.forEach((row, lineIndex) => {
  for (const [key, amount] of Object.entries(row.events)) {
    if (amount) allocations.push({ eventKey: key as EventKey, lineIndex, amount })
  }
})
// Adjustment-event allocations (resolved by exact description match against MATRIX).
for (const adj of ADJUSTMENT_EVENTS) {
  for (const a of adj.allocations) {
    const lineIndex = MATRIX.findIndex((r) => r.description === a.lineDescription)
    if (lineIndex === -1) throw new Error(`Adjustment event ${adj.key}: line "${a.lineDescription}" not found in MATRIX`)
    allocations.push({ eventKey: adj.key, lineIndex, amount: a.amount })
  }
}

// -- Xero matching: exact single-event-to-single-receipt only --------------
type XeroMatch = { eventKey: EventKey; receipt: XeroReceipt }
const xeroMatches: XeroMatch[] = []
{
  const used = new Set<string>()
  for (const e of computedEvents) {
    if (e.directPayment) continue
    const hit = XERO_RECEIPTS.find((r) => !used.has(r.bankTransactionId) && Math.abs(r.amount - e.certifiedTotal) < 0.005)
    if (hit) {
      xeroMatches.push({ eventKey: e.key, receipt: hit })
      used.add(hit.bankTransactionId)
    }
  }
}
const matchedReceiptIds = new Set(xeroMatches.map((m) => m.receipt.bankTransactionId))
const unmatchedReceipts = XERO_RECEIPTS.filter((r) => !matchedReceiptIds.has(r.bankTransactionId))
const cashReceivedByEvent = new Map<EventKey, XeroReceipt>(xeroMatches.map((m) => [m.eventKey, m.receipt]))

async function main() {
  const L = "=".repeat(88)
  console.log(`\n${L}\nGOLDENTREE DRAWDOWN LAYER — ${DRY_RUN ? "DRY RUN" : "EXECUTE"}\n${L}`)
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no DB writes, no Blob uploads, no network calls)" : "EXECUTE (will write to Postgres and Blob)"}`)
  console.log(`Master matrix: ${MASTER_MATRIX_PATH}`)

  const budgetRes = await pool.query(
    `SELECT id, works_total, professional_fees_total, original_total FROM funding_budgets
     WHERE project_id = $1 AND is_original = true ORDER BY created_at ASC LIMIT 1`,
    [PROJECT_ID],
  )
  if (budgetRes.rows.length === 0) throw new Error("No original funding budget for project — nothing to attach drawdown events to.")
  const budget = budgetRes.rows[0]
  const lineRes = await pool.query(
    `SELECT id, position, description, original_amount FROM funding_budget_lines
     WHERE funding_budget_id = $1 ORDER BY position ASC, id ASC`,
    [budget.id],
  )
  const lines = lineRes.rows as { id: number; position: number; description: string; original_amount: string }[]
  if (lines.length !== MATRIX.length) {
    console.error(`FAIL: funding_budget_lines count (${lines.length}) != MATRIX rows (${MATRIX.length}). Stopping.`)
    await pool.end()
    process.exit(1)
  }

  // -- Row-level reconciliation (unchanged check from first delivery) -----
  let rowFail = 0
  for (const row of MATRIX) {
    const eventsSum = round2(Object.values(row.events).reduce((a, b) => a + (b ?? 0), 0))
    const calc = round2(eventsSum + row.amountLeftToDraw)
    if (Math.abs(calc - row.originalAmount) > 0.01) rowFail++
  }
  console.log(`\n1) PER-LINE RECONCILIATION: ${rowFail === 0 ? "ALL 48 LINES RECONCILE to the penny." : `${rowFail} FAIL`}`)

  console.log(`\n2) DRAWDOWN EVENTS (18 original + 2 footer-adjustment = 20)`)
  console.log(`   ${"Event key".padEnd(26)} ${"Label".padEnd(24)} ${"Certified".padStart(13)}  Direct  cash_received  received_date`)
  let certifiedSum = 0
  for (const e of computedEvents) {
    certifiedSum += e.certifiedTotal
    const cr = cashReceivedByEvent.get(e.key)
    console.log(`   ${e.key.padEnd(26)} ${e.label.padEnd(24)} ${gbp(e.certifiedTotal).padStart(13)}  ${e.directPayment ? "YES   " : "no    "}  ${(cr ? gbp(cr.amount) : "NULL").padStart(13)}  ${cr?.date ?? "—"}`)
  }
  for (const adj of ADJUSTMENT_EVENTS) {
    certifiedSum += adj.certifiedTotal
    console.log(`   ${adj.key.padEnd(26)} ${adj.label.slice(0, 24).padEnd(24)} ${gbp(adj.certifiedTotal).padStart(13)}  no      ${"NULL".padStart(13)}  —`)
  }
  console.log(`   TOTAL across all 20 events: ${gbp(round2(certifiedSum))}`)

  console.log(`\n3) XERO CASH-RECEIVED MATCHING (10 receipts, £${XERO_RECEIPTS.reduce((a, r) => a + r.amount, 0).toFixed(2)})`)
  console.log(`   EXACT matches written (${xeroMatches.length} of 10):`)
  for (const m of xeroMatches) console.log(`     ${m.eventKey.padEnd(26)} <- ${gbp(m.receipt.amount)} on ${m.receipt.date} ("${m.receipt.description}", ${m.receipt.bankTransactionId})`)
  console.log(`   NOT matched — stay NULL, reported only (${unmatchedReceipts.length} of 10):`)
  for (const r of unmatchedReceipts) console.log(`     ${gbp(r.amount)} on ${r.date} ("${r.description}", ${r.bankTransactionId}) — see val1_1st_release/balance_of_val1/val6_mip notes for the explained-but-unwritten reasoning`)
  const matchedSum = round2(xeroMatches.reduce((a, m) => a + m.receipt.amount, 0))
  const unmatchedSum = round2(unmatchedReceipts.reduce((a, r) => a + r.amount, 0))
  console.log(`   Matched sum ${gbp(matchedSum)} + unmatched sum ${gbp(unmatchedSum)} = ${gbp(round2(matchedSum + unmatchedSum))} (Xero total ${gbp(567618.62)})`)

  console.log(`\n4) BRIDGE CHECK: borrower events (10) + 2 adjustment events = Xero total?`)
  const borrowerSum = round2(computedEvents.filter((e) => !e.directPayment).reduce((a, e) => a + e.certifiedTotal, 0))
  const adjSum = round2(ADJUSTMENT_EVENTS.reduce((a, e) => a + e.certifiedTotal, 0))
  console.log(`   Borrower-side events sum:  ${gbp(borrowerSum)}`)
  console.log(`   + adjustment events sum:   ${gbp(adjSum)}`)
  console.log(`   = ${gbp(round2(borrowerSum + adjSum))}   vs Xero £567,618.62   ${Math.abs(borrowerSum + adjSum - 567618.62) < 0.01 ? "EXACT MATCH." : "MISMATCH."}`)

  // -- Blob/source plan --
  console.log(`\n5) SOURCE DOCUMENTS TO UPLOAD (--execute only)`)
  const docsToUpload = [
    { path: MASTER_MATRIX_PATH, exists: existsSync(MASTER_MATRIX_PATH), usedFor: "17 of 20 events (all except timber_frame + the 4 target_timber_systems_*)" },
    { path: STAGE_CERT_FOUNDATIONS_PATH, exists: existsSync(STAGE_CERT_FOUNDATIONS_PATH), usedFor: "corroborating note on val1_1st_release" },
    { path: STAGE_CERT_TIMBER_FRAME_PATH, exists: existsSync(STAGE_CERT_TIMBER_FRAME_PATH), usedFor: "corroborating note on val3_mip" },
    { path: STAGE_CERT_DPM_PATH, exists: existsSync(STAGE_CERT_DPM_PATH), usedFor: "corroborating note on val7_mip" },
    ...TARGET_TIMBER_INVOICES.map((t) => ({ path: t.filePath, exists: existsSync(t.filePath), usedFor: `invoice ${t.invoiceNumber} + source for event ${t.eventKey}` })),
  ]
  for (const d of docsToUpload) console.log(`   ${d.exists ? "OK  " : "MISSING"} ${d.path.split("/").pop()}  -> ${d.usedFor}`)
  console.log(`   timber_frame event will reuse invoice #218's EXISTING Blob upload (no re-upload).`)
  if (docsToUpload.some((d) => !d.exists)) {
    console.error(`\n   FAIL: one or more source files are missing on disk. Refusing to proceed to --execute logic.`)
    await pool.end()
    process.exit(1)
  }

  // -- Target Timber invoice ingestion plan --
  console.log(`\n6) TARGET TIMBER INVOICE INGESTION PLAN (item 3)`)
  const existingInvRes = await pool.query(
    `SELECT invoice_number FROM invoices WHERE supplier_id = $1 AND transaction_type = 'invoice' AND invoice_number IS NOT NULL`,
    [TARGET_TIMBER_SUPPLIER_ID],
  )
  const existingNumbers = new Set((existingInvRes.rows as any[]).map((r) => normaliseDocNumber(r.invoice_number)))
  const pkgRes = await pool.query(`SELECT id, code, name FROM cost_packages WHERE project_id = $1 AND code = $2`, [PROJECT_ID, TARGET_TIMBER_COST_PACKAGE_CODE])
  const costPackageId: number | null = pkgRes.rows[0]?.id ?? null
  console.log(`   cost_package_code '${TARGET_TIMBER_COST_PACKAGE_CODE}' -> ${costPackageId ? `id ${costPackageId} (${pkgRes.rows[0].name})` : "NOT FOUND — would leave cost_package_id NULL"}`)
  console.log(`   supplier: existing #${TARGET_TIMBER_SUPPLIER_ID} "Target Timber Frames" (never creating a new supplier)`)

  const seenThisBatch = new Set<string>()
  type InvoicePlanRow = { action: "INSERT" | "SKIP-DUPLICATE-DB" | "SKIP-DUPLICATE-BATCH"; inv: TargetTimberInvoice; reason?: string }
  const invoicePlan: InvoicePlanRow[] = []
  for (const inv of TARGET_TIMBER_INVOICES) {
    const nNumber = normaliseDocNumber(inv.invoiceNumber)
    if (existingNumbers.has(nNumber)) {
      invoicePlan.push({ action: "SKIP-DUPLICATE-DB", inv, reason: `invoice ${inv.invoiceNumber} already exists for supplier #${TARGET_TIMBER_SUPPLIER_ID}` })
      continue
    }
    if (seenThisBatch.has(nNumber)) {
      invoicePlan.push({ action: "SKIP-DUPLICATE-BATCH", inv, reason: "duplicate within this batch" })
      continue
    }
    seenThisBatch.add(nNumber)
    invoicePlan.push({ action: "INSERT", inv })
  }
  for (const r of invoicePlan) {
    console.log(
      `   ${r.action.padEnd(20)} ${r.inv.invoiceNumber}  ${r.inv.invoiceDate}  ${gbp(r.inv.net)}  "${r.inv.description}"  pkg=${TARGET_TIMBER_COST_PACKAGE_CODE}${r.reason ? `  — ${r.reason}` : ""}`,
    )
  }
  const invoicesToInsert = invoicePlan.filter((r) => r.action === "INSERT")
  console.log(`   Planned inserts: ${invoicesToInsert.length} of ${TARGET_TIMBER_INVOICES.length}, total net £${invoicesToInsert.reduce((a, r) => a + r.inv.net, 0).toFixed(2)}`)

  // -- funding_drawdowns preview --
  console.log(`\n7) funding_drawdowns PREVIEW (funding_drawn = sum of that line's allocations, incl. adjustment events)`)
  let previewCount = 0
  const drawnByLine: number[] = MATRIX.map(() => 0)
  for (const a of allocations) drawnByLine[a.lineIndex] = round2(drawnByLine[a.lineIndex] + a.amount)
  for (let i = 0; i < MATRIX.length; i++) {
    if (drawnByLine[i] !== 0) {
      previewCount++
      console.log(`   line ${lines[i].id} (pos ${i}) "${MATRIX[i].description.slice(0, 48)}": funding_drawn -> ${gbp(drawnByLine[i])}`)
    }
  }
  console.log(`   ${previewCount} of 48 lines would get a non-zero funding_drawn.`)

  console.log(`\n8) ALLOCATIONS TO BE WRITTEN: ${allocations.length} cells (incl. 1 for adj_sanitaryware_cert6; adj_vat_direct_pay has 0 — deliberately unallocated, non-negotiable #3)`)
  const allocSum = round2(allocations.reduce((a, x) => a + x.amount, 0))
  const unallocatedTotal = round2(ADJUSTMENT_EVENTS.filter((e) => e.allocations.length === 0).reduce((a, e) => a + e.certifiedTotal, 0))
  console.log(`   Sum of all allocation amounts:              ${gbp(allocSum)}`)
  console.log(`   + deliberately-unallocated event totals:    ${gbp(unallocatedTotal)}  (adj_vat_direct_pay — see non-negotiable #3)`)
  console.log(`   = ${gbp(round2(allocSum + unallocatedTotal))}  vs sum of all 20 event certified totals: ${gbp(round2(certifiedSum))}  ${Math.abs(allocSum + unallocatedTotal - certifiedSum) < 0.01 ? "MATCH." : "MISMATCH — investigate before writing."}`)

  if (DRY_RUN) {
    console.log(`\n${L}\nDry run only — nothing written to Postgres, nothing uploaded to Blob.`)
    console.log(`Re-run with --execute to write funding_drawdown_events (20 rows), funding_drawdown_allocations`)
    console.log(`(${allocations.length} rows), funding_drawdowns (${previewCount} rows), and ${invoicesToInsert.length} new Target Timber invoices.`)
    console.log(`${L}\n`)
    await pool.end()
    return
  }

  // =========================================================================
  // EXECUTE
  // =========================================================================
  console.log(`\n${L}\nEXECUTING\n${L}`)

  async function uploadFile(filePath: string, blobPrefix: string) {
    const bytes = readFileSync(filePath)
    const hash = createHash("sha256").update(bytes).digest("hex")
    const safeName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "_")
    const blob = await put(`${blobPrefix}/${Date.now()}-${safeName}`, bytes, {
      access: "public",
      contentType: "application/pdf",
      addRandomSuffix: true,
    })
    return { name: path.basename(filePath), pathname: blob.url, hash }
  }

  // -- 6a) Upload master matrix + 3 stage certs --
  console.log("Uploading master matrix + stage-release certificates to Blob...")
  const masterBlob = await uploadFile(MASTER_MATRIX_PATH, "drawdown-events")
  const foundationsBlob = await uploadFile(STAGE_CERT_FOUNDATIONS_PATH, "drawdown-events")
  const timberFrameCertBlob = await uploadFile(STAGE_CERT_TIMBER_FRAME_PATH, "drawdown-events")
  const dpmBlob = await uploadFile(STAGE_CERT_DPM_PATH, "drawdown-events")
  console.log(`  master matrix -> ${masterBlob.pathname}`)
  console.log(`  Foundations cert -> ${foundationsBlob.pathname}`)
  console.log(`  Timber frame cert -> ${timberFrameCertBlob.pathname}`)
  console.log(`  DPM cert -> ${dpmBlob.pathname}`)

  // -- 6b) Ingest Target Timber invoices (own transaction per invoice, four-layer duplicate protection) --
  console.log("\nIngesting Target Timber invoices...")
  const targetTimberBlobByEvent = new Map<EventKey, { name: string; pathname: string; hash: string }>()
  let invInserted = 0
  let invDupCaught = 0
  for (const r of invoicesToInsert) {
    const inv = r.inv
    const blob = await uploadFile(inv.filePath, "invoices")
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      // In-transaction re-check (layer 3) — same shape as commitInvoice.
      const nNumber = normaliseDocNumber(inv.invoiceNumber)
      const dupCheck = await client.query(
        `SELECT id FROM invoices WHERE supplier_id = $1 AND transaction_type = 'invoice'`,
        [TARGET_TIMBER_SUPPLIER_ID],
      )
      const dupe = (dupCheck.rows as any[]).find((row) => normaliseDocNumber(row.invoice_number) === nNumber)
      if (dupe) {
        await client.query("ROLLBACK")
        invDupCaught++
        console.log(`  DUPLICATE (caught at commit) ${inv.invoiceNumber}`)
        continue
      }

      const vatRate = inv.net !== 0 ? round2((inv.vat / inv.net) * 100) : null
      const notes =
        `${inv.dueNote}. Addressed to 'Gilbert Build Co Ltd c/o Goldentree Financial Services PLC' — ` +
        `paid by the lender directly, not through the company's own bank account ` +
        `(see funding_drawdown_events.${inv.eventKey}).`

      const invRes = await client.query(
        `INSERT INTO invoices
           (supplier_id, project_id, invoice_number, invoice_date, transaction_type,
            net, vat, gross, status, source_file_name, source_file_pathname, source_file_hash,
            source_page_start, source_page_end, notes, needs_review, reconciled,
            payment_status, payment_notes)
         VALUES ($1,$2,$3,$4,'invoice',$5,$6,$7,'confirmed',$8,$9,$10,1,1,$11,true,true,'paid',$12)
         RETURNING id`,
        [
          TARGET_TIMBER_SUPPLIER_ID, PROJECT_ID, inv.invoiceNumber, inv.invoiceDate,
          String(inv.net), String(inv.vat), String(inv.gross),
          blob.name, blob.pathname, blob.hash, notes, TARGET_TIMBER_PAYMENT_NOTES,
        ],
      )
      const invoiceId = invRes.rows[0].id

      await client.query(
        `INSERT INTO invoice_line_items
           (invoice_id, product_id, cost_package_id, description, raw_description,
            quantity, unit, raw_unit, normalised_unit, unit_price_ex_vat,
            line_net, line_vat, line_gross, vat_rate, is_price_tracked)
         VALUES ($1,NULL,$2,$3,$3,NULL,NULL,NULL,NULL,NULL,$4,$5,$6,$7,false)`,
        [invoiceId, costPackageId, inv.description, String(inv.net), String(inv.vat), String(inv.gross), vatRate == null ? null : String(vatRate)],
      )

      if (costPackageId != null) {
        const pkgRow = await client.query("SELECT code, name FROM cost_packages WHERE id = $1", [costPackageId])
        const pkg = pkgRow.rows[0]
        const productKey = normaliseDescriptionKey(inv.description)
        if (productKey && pkg) {
          await client.query(
            `INSERT INTO classification_mappings
               (key_kind, key_value, supplier_id, cost_package_code, cost_package_name, times_confirmed)
             VALUES ('product', $1, $2, $3, $4, 1)
             ON CONFLICT (key_kind, key_value, (coalesce(supplier_id, 0)))
             DO UPDATE SET
               cost_package_code = COALESCE(EXCLUDED.cost_package_code, classification_mappings.cost_package_code),
               cost_package_name = COALESCE(EXCLUDED.cost_package_name, classification_mappings.cost_package_name),
               times_confirmed = classification_mappings.times_confirmed + 1,
               updated_at = now()`,
            [productKey, TARGET_TIMBER_SUPPLIER_ID, pkg.code, pkg.name],
          )
        }
      }
      const supNorm = normaliseSupplierName("Target Timber Frames")
      if (supNorm) {
        await client.query(
          `INSERT INTO supplier_aliases (supplier_id, normalised_name, raw_name)
           VALUES ($1, $2, $3) ON CONFLICT (normalised_name) DO NOTHING`,
          [TARGET_TIMBER_SUPPLIER_ID, supNorm, "Target Timber Frames"],
        )
      }

      await client.query("COMMIT")
      invInserted++
      targetTimberBlobByEvent.set(inv.eventKey, blob)
      console.log(`  INSERTED ${inv.invoiceNumber} -> invoice #${invoiceId}`)
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      if ((err as { code?: string }).code === "23505") {
        invDupCaught++
        console.log(`  DUPLICATE (unique index) ${inv.invoiceNumber}`)
      } else {
        throw err
      }
    } finally {
      client.release()
    }
  }
  console.log(`Target Timber invoices: ${invInserted} inserted, ${invDupCaught} duplicates caught.`)

  // -- 6c) Resolve timber_frame's source from the existing invoice #218 --
  const int6503 = await pool.query(
    `SELECT source_file_name, source_file_pathname, source_file_hash FROM invoices WHERE id = 218`,
  )
  const timberFrameSource = int6503.rows[0] ?? null

  // -- 6d) Write funding_drawdown_events + funding_drawdown_allocations (replace-in-place, idempotent) --
  console.log("\nWriting funding_drawdown_events + funding_drawdown_allocations...")
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(
      `DELETE FROM funding_drawdown_allocations WHERE event_id IN
         (SELECT id FROM funding_drawdown_events WHERE funding_budget_id = $1)`,
      [budget.id],
    )
    await client.query(`DELETE FROM funding_drawdown_events WHERE funding_budget_id = $1`, [budget.id])

    const eventIdByKey = new Map<string, number>()

    for (const e of computedEvents) {
      let sourceName = masterBlob.name
      let sourcePathname = masterBlob.pathname
      let sourceHash = masterBlob.hash
      let notes = e.notes

      if (e.key === "timber_frame" && timberFrameSource) {
        sourceName = timberFrameSource.source_file_name
        sourcePathname = timberFrameSource.source_file_pathname
        sourceHash = timberFrameSource.source_file_hash
      } else if (targetTimberBlobByEvent.has(e.key)) {
        const b = targetTimberBlobByEvent.get(e.key)!
        sourceName = b.name
        sourcePathname = b.pathname
        sourceHash = b.hash
      } else if (e.key === "val1_1st_release") {
        notes += ` [Corroborating: Foundations stage cert uploaded to ${foundationsBlob.pathname}]`
      } else if (e.key === "val3_mip") {
        notes += ` [Corroborating: Timber frame stage cert uploaded to ${timberFrameCertBlob.pathname}]`
      } else if (e.key === "val7_mip") {
        notes += ` [Corroborating: DPM stage cert uploaded to ${dpmBlob.pathname}]`
      }

      const cr = cashReceivedByEvent.get(e.key)
      const ins = await client.query(
        `INSERT INTO funding_drawdown_events
           (funding_budget_id, event_key, label, event_date, certified_total, cash_received, received_date,
            direct_payment, notes, source_file_name, source_file_pathname, source_file_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          budget.id, e.key, e.label, e.eventDate, String(e.certifiedTotal),
          cr ? String(cr.amount) : null, cr ? cr.date : null,
          e.directPayment, notes, sourceName, sourcePathname, sourceHash,
        ],
      )
      eventIdByKey.set(e.key, ins.rows[0].id)
    }

    for (const adj of ADJUSTMENT_EVENTS) {
      const ins = await client.query(
        `INSERT INTO funding_drawdown_events
           (funding_budget_id, event_key, label, event_date, certified_total, cash_received, received_date,
            direct_payment, notes, source_file_name, source_file_pathname, source_file_hash)
         VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,$7,$8,$9,$10) RETURNING id`,
        [budget.id, adj.key, adj.label, adj.eventDate, String(adj.certifiedTotal), adj.directPayment, adj.notes, masterBlob.name, masterBlob.pathname, masterBlob.hash],
      )
      eventIdByKey.set(adj.key, ins.rows[0].id)
    }

    let allocInserted = 0
    for (const a of allocations) {
      const eventId = eventIdByKey.get(a.eventKey)
      const lineId = lines[a.lineIndex].id
      if (!eventId) throw new Error(`internal: no event id for ${a.eventKey}`)
      await client.query(
        `INSERT INTO funding_drawdown_allocations (event_id, funding_budget_line_id, amount) VALUES ($1,$2,$3)`,
        [eventId, lineId, String(a.amount)],
      )
      allocInserted++
    }

    await client.query("COMMIT")
    console.log(`  ${eventIdByKey.size} events written, ${allocInserted} allocations written.`)
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // -- 6e) Upsert funding_drawdowns per line (funding_drawn = cumulative allocations) --
  console.log("\nUpserting funding_drawdowns...")
  let drawdownRows = 0
  for (let i = 0; i < MATRIX.length; i++) {
    if (drawnByLine[i] === 0) continue
    await pool.query(
      `INSERT INTO funding_drawdowns (funding_budget_line_id, funding_drawn, updated_at)
       VALUES ($1,$2,now())
       ON CONFLICT (funding_budget_line_id) DO UPDATE SET funding_drawn = EXCLUDED.funding_drawn, updated_at = now()`,
      [lines[i].id, String(drawnByLine[i])],
    )
    drawdownRows++
  }
  console.log(`  ${drawdownRows} funding_drawdowns rows upserted (funding_certified / work_complete_pct left untouched/NULL).`)

  console.log(`\n${L}\nEXECUTE complete.\n${L}\n`)
  await pool.end()
}

main().catch(async (e) => {
  console.error("ERROR:", e)
  await pool.end()
  process.exit(1)
})
