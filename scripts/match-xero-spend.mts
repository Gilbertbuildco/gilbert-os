/**
 * CLI for lib/reconciliation/match-spend.ts — matches Xero SPEND bank
 * transactions to unpaid Gilbert OS invoices.
 *
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/match-xero-spend.mts            # dry run
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/match-xero-spend.mts --execute  # apply
 *
 * Dry run is the default and writes nothing. Only unambiguous single matches
 * are ever applied; bulk-payment candidates and ambiguous amounts are reported
 * for the owner to decide.
 */
import { matchSpendToInvoices } from "../lib/reconciliation/match-spend"

const execute = process.argv.includes("--execute")
const money = (n: number) => `£${n.toFixed(2)}`

const r = await matchSpendToInvoices({ execute })

console.log(`\nXero SPEND transactions fetched: ${r.spendFetched}\n`)

console.log(`--- MATCHED: invoice settled by a bank payment (${r.matches.length}) ---`)
for (const m of r.matches)
  console.log(`  ${m.paidDate}  ${m.invoiceNumber.padEnd(12)} ${m.supplier.slice(0, 30).padEnd(31)} ${money(m.gross).padStart(11)}  ${m.from ?? "not recorded"} -> paid`)
if (!r.matches.length) console.log("  none")

if (r.bulkCandidates.length) {
  console.log(`\n--- BULK PAYMENT CANDIDATES — reported only, your call (${r.bulkCandidates.length}) ---`)
  for (const b of r.bulkCandidates)
    console.log(`  ${b.paidDate}  ${b.supplier.slice(0, 26).padEnd(27)} ${money(b.amount).padStart(11)} = ${b.invoices.map((i) => `${i.number} ${money(i.gross)}`).join(" + ")}`)
}

if (r.ambiguous.length) {
  console.log(`\n--- AMBIGUOUS — same amount fits several invoices, never guessed (${r.ambiguous.length}) ---`)
  for (const a of r.ambiguous) console.log(`  ${a.paidDate}  ${a.supplier.slice(0, 26).padEnd(27)} ${money(a.amount).padStart(11)}  could be: ${a.candidates.join(", ")}`)
}

if (r.protectedSkips.length) {
  console.log(`\n--- PROTECTED (owner assertion, untouched) (${r.protectedSkips.length}) ---`)
  for (const p of r.protectedSkips) console.log(`  ${p.invoiceNumber.padEnd(12)} ${p.supplier.slice(0, 30)}`)
}

const bySupplier = new Map<string, { n: number; total: number }>()
for (const n of r.noInvoice) {
  const g = bySupplier.get(n.supplier) ?? { n: 0, total: 0 }
  g.n++; g.total += n.amount
  bySupplier.set(n.supplier, g)
}
console.log(`\n--- PAYMENTS MISSING AN INVOICE (${r.noInvoice.length}, ${money(r.missingTotal)}) ---`)
for (const [s, g] of [...bySupplier.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 20))
  console.log(`  ${String(g.n).padStart(3)}  ${money(g.total).padStart(12)}  ${s}`)

console.log(`\nApplied: ${r.applied}  Errors: ${r.errors.length}`)
for (const e of r.errors) console.log(`  ! ${e}`)
if (!execute) console.log("\nDRY RUN — nothing written. Re-run with --execute to apply the matches above.")
