import type { GoldentreeSchedule } from "@/lib/funding/goldentree"
import { cn } from "@/lib/utils"

const money = (n: number) =>
  n === 0 ? "" : `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const money0 = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`

/**
 * The lender's schedule as they present it: their lines down the side in their
 * own order, their certificates across the top, their values in the cells.
 * Nothing is re-sorted or re-grouped (non-negotiable #2).
 */
export function GoldentreeView({ g }: { g: GoldentreeSchedule }) {
  const works = g.rows.filter((r) => r.section === "works")
  const fees = g.rows.filter((r) => r.section === "professional_fees")

  const renderRows = (rows: typeof g.rows) =>
    rows.map((r) => (
      <tr key={r.lineId} className="border-b border-border/50 last:border-0">
        <th scope="row" className="sticky left-0 z-10 max-w-[15rem] border-r border-border bg-card px-3 py-2 text-left font-normal">
          {r.description}
        </th>
        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">{money(r.original)}</td>
        {g.events.map((e) => {
          const cell = r.cells.find((c) => c.eventId === e.id)
          return (
            <td key={e.id} className={cn("whitespace-nowrap px-3 py-2 text-right tabular-nums",
              cell && cell.amount < 0 && "text-red-600 dark:text-red-400")}>
              {cell ? money(cell.amount) : ""}
            </td>
          )
        })}
        <td className="whitespace-nowrap border-l border-border px-3 py-2 text-right tabular-nums font-medium">{money(r.drawn)}</td>
        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">{money(r.remaining)}</td>
      </tr>
    ))

  const sectionTotal = (rows: typeof g.rows, pick: (r: typeof g.rows[number]) => number) =>
    rows.reduce((s, r) => s + pick(r), 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Facility", money0(g.amountToBorrow ?? g.totals.original), g.lender ?? ""],
          ["Certified to date", money0(g.totals.certified), `${g.events.length} certificates`],
          ["Released to you", money0(g.totals.cashReceived), `${money0(g.totals.directPayments)} paid direct to suppliers`],
          ["Remaining", money0((g.amountToBorrow ?? g.totals.original) - g.totals.certified), "against the facility"],
        ].map(([label, value, sub]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">{g.budgetName}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {g.lender}&rsquo;s own lines, in their order, with every certificate as a column. Values are exactly as
            certified — nothing re-sorted, re-grouped or rebalanced.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b-2 border-border">
                <th className="sticky left-0 z-20 border-r border-border bg-card px-3 py-2 text-left font-semibold">Line</th>
                <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Budget</th>
                {g.events.map((e) => (
                  <th key={e.id} className="whitespace-nowrap px-3 py-2 text-right font-semibold" title={e.notes ?? undefined}>
                    <div>{e.label}</div>
                    <div className="mt-0.5 font-normal text-muted-foreground">
                      {e.date ?? "—"}{e.directPayment ? " · direct" : ""}
                    </div>
                  </th>
                ))}
                <th className="whitespace-nowrap border-l border-border px-3 py-2 text-right font-semibold">Drawn</th>
                <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Left</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-muted/40"><th colSpan={g.events.length + 4} scope="colgroup"
                className="sticky left-0 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide">Works</th></tr>
              {renderRows(works)}
              <tr className="border-y border-border bg-muted/20 font-medium">
                <th scope="row" className="sticky left-0 z-10 border-r border-border bg-muted/20 px-3 py-2 text-left">Works total</th>
                <td className="px-3 py-2 text-right tabular-nums">{money(sectionTotal(works, (r) => r.original))}</td>
                {g.events.map((e) => (
                  <td key={e.id} className="px-3 py-2 text-right tabular-nums">
                    {money(works.reduce((s, r) => s + (r.cells.find((c) => c.eventId === e.id)?.amount ?? 0), 0))}
                  </td>
                ))}
                <td className="border-l border-border px-3 py-2 text-right tabular-nums">{money(sectionTotal(works, (r) => r.drawn))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(sectionTotal(works, (r) => r.remaining))}</td>
              </tr>

              <tr className="bg-muted/40"><th colSpan={g.events.length + 4} scope="colgroup"
                className="sticky left-0 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide">Professional fees</th></tr>
              {renderRows(fees)}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                <th scope="row" className="sticky left-0 z-10 border-r border-border bg-card px-3 py-2 text-left">Total</th>
                <td className="px-3 py-2 text-right tabular-nums">{money(g.totals.original)}</td>
                {g.events.map((e) => (
                  <td key={e.id} className="px-3 py-2 text-right tabular-nums">
                    {money(g.rows.reduce((s, r) => s + (r.cells.find((c) => c.eventId === e.id)?.amount ?? 0), 0))}
                  </td>
                ))}
                <td className="border-l border-border px-3 py-2 text-right tabular-nums">{money(g.totals.drawn)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(g.totals.remaining)}</td>
              </tr>
              <tr className="text-muted-foreground">
                <th scope="row" className="sticky left-0 z-10 border-r border-border bg-card px-3 py-2 text-left font-normal">Certified on the certificate</th>
                <td />
                {g.events.map((e) => (
                  <td key={e.id} className="px-3 py-2 text-right tabular-nums">{money(e.certified)}</td>
                ))}
                <td className="border-l border-border px-3 py-2 text-right tabular-nums">{money(g.totals.certified)}</td>
                <td />
              </tr>
              <tr className="text-muted-foreground">
                <th scope="row" className="sticky left-0 z-10 border-r border-border bg-card px-3 py-2 text-left font-normal">Cash received</th>
                <td />
                {g.events.map((e) => (
                  <td key={e.id} className="px-3 py-2 text-right tabular-nums">
                    {e.directPayment ? <span className="opacity-60">direct</span> : money(e.cashReceived)}
                  </td>
                ))}
                <td className="border-l border-border px-3 py-2 text-right tabular-nums">{money(g.totals.cashReceived)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {Math.abs(g.unallocatedTotal) > 0.005 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-5 text-sm">
          <h3 className="font-semibold">Certified but not allocated to a line</h3>
          <p className="mt-1 text-muted-foreground">
            The certificates total {money(g.totals.certified)}; the line allocations total {money(g.totals.drawn)}. The
            difference of <strong className="tabular-nums text-foreground">{money(g.unallocatedTotal)}</strong> is shown
            rather than absorbed into a line.
          </p>
          <ul className="mt-2 space-y-1">
            {g.events.filter((e) => Math.abs(e.unallocated) > 0.005).map((e) => (
              <li key={e.id} className="flex justify-between gap-4">
                <span>{e.label}</span><span className="tabular-nums">{money(e.unallocated)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
