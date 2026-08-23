import type { CashPosition } from "@/lib/funding/cash-position"
import { cn } from "@/lib/utils"

const money = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const money0 = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums",
        tone === "good" && "text-emerald-600 dark:text-emerald-400",
        tone === "bad" && "text-amber-600 dark:text-amber-400")}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

function Bar({ label, pct, amount, total, className }: { label: string; pct: number; amount: number; total: number; className: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {money0(amount)} <span className="opacity-60">of {money0(total)}</span> · {pct.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1.5 h-3 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", className)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  )
}

export function CashPositionView({ p }: { p: CashPosition }) {
  const ahead = p.drawnAheadOfCost >= 0
  const knownPct = p.facility > 0 ? (p.knownCost / p.facility) * 100 : 0

  return (
    <div className="flex flex-col gap-6">
      {p.cash ? (
        <div className={cn("rounded-lg border p-5",
          (p.cashAfterBills ?? 0) < 0 ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5")}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Cash in the bank</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums">{money(p.cash.amount)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{p.cash.source} · {p.cash.asAt}</div>
            </div>
            <div className="text-right">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bills to pay</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                {money(p.outstandingGross)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{p.outstandingCount} invoices</div>
            </div>
          </div>
          <p className="mt-4 border-t border-border/60 pt-3 text-sm">
            {(p.cashAfterBills ?? 0) < 0 ? (
              <>
                Settling everything owed would leave you{" "}
                <strong className="text-amber-600 dark:text-amber-400">{money(Math.abs(p.cashAfterBills ?? 0))} short</strong>
                {" "}— so a drawdown is needed before the bills are cleared. {money(p.leftToDraw)} remains available.
              </>
            ) : (
              <>Cash covers everything currently owed, with {money(p.cashAfterBills ?? 0)} to spare.</>
            )}
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Left to draw" value={money(p.leftToDraw)} sub={`${money0(p.certifiedToDate)} drawn of ${money0(p.facility)}`} />
        <Stat label="Left to spend" value={money(p.leftToSpend)} sub={`${money0(p.committed)} committed`} />
        <Stat label="Outstanding" value={money(p.outstandingGross)} sub={`${p.outstandingCount} invoices · ${money0(p.outstandingNet)} ex-VAT`} tone="bad" />
        <Stat label="Spent to date" value={money(p.spentToDate)} sub={`ex-VAT${p.nonBuildSpend > 0 ? ` · plus ${money0(p.nonBuildSpend)} non-build` : ""}`} />
      </div>

      {/* Where the money will end up, in tiers of decreasing certainty. */}
      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="text-sm font-semibold">Where the budget ends up</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Each tier is a different kind of certainty. Nothing here is estimated.
        </p>
        <div className="mt-4 space-y-3">
          <Bar label="Invoiced + owed" pct={p.committedPct} amount={p.committed} total={p.facility} className="bg-violet-500" />
          <Bar label="+ accepted quotes not yet billed" pct={knownPct} amount={p.knownCost} total={p.facility} className="bg-sky-500" />
          <Bar label="Drawn from the facility" pct={p.drawnPct} amount={p.certifiedToDate} total={p.facility} className="bg-emerald-500" />
        </div>
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-muted-foreground">Committed (hard)</dt><dd className="tabular-nums font-medium">{money(p.committed)}</dd></div>
          <div><dt className="text-muted-foreground">Contracted, unbilled</dt><dd className="tabular-nums font-medium">{money(p.contracted)}</dd></div>
          <div><dt className="text-muted-foreground">Budget not yet spent or quoted</dt><dd className="tabular-nums font-medium">{money(p.unallocated)}</dd></div>
        </dl>
        {p.nonBuildSpend > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            A further <strong className="text-foreground">{money(p.nonBuildSpend)}</strong> has been spent on costs the
            lender&apos;s budget does not cover — legal and broker fees, vehicles. Real money out, but deliberately outside
            every figure above.
          </p>
        ) : null}
        <p className="mt-4 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">{money(p.unallocated)}</strong> of the facility covers work with neither an
          invoice nor an accepted quote against it. That figure is the lender&apos;s own allowance — not a forecast of what
          the work will cost. Until the remaining trades are quoted, it is the honest limit of what this can tell you.
        </p>
      </div>

      <div className={cn("rounded-lg border p-5", ahead ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5")}>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {ahead ? "Drawn ahead of cost" : "Cost ahead of drawings"}
        </div>
        <div className={cn("mt-1 text-3xl font-semibold tabular-nums",
          ahead ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400")}>
          {money(Math.abs(p.drawnAheadOfCost))}
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          {money(p.certifiedToDate)} certified against {money(p.committed)} of committed cost.{" "}
          {ahead
            ? "You are holding lender money ahead of the cost incurred — good for cash flow, but the same amount less facility remains for the work still to come."
            : "You have spent ahead of what has been certified; that cash is yours until the next valuation reimburses it."}
        </p>
      </div>

      {/* Owed, grouped — headline per supplier, invoices on demand. */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-baseline justify-between border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold">What you owe</h3>
          <span className="tabular-nums text-sm text-muted-foreground">
            {money(p.outstandingGross)} across {p.owed.length} suppliers
          </span>
        </div>
        <ul>
          {p.owed.map((o) => (
            <li key={o.supplier} className="border-b border-border/60 last:border-0">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 hover:bg-muted/40">
                  <span className="flex items-center gap-2">
                    <svg viewBox="0 0 20 20" aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90">
                      <path d="M7 5l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="font-medium">{o.supplier}</span>
                    <span className="text-xs text-muted-foreground">
                      {o.count} {o.count === 1 ? "invoice" : "invoices"}
                    </span>
                  </span>
                  <span className="tabular-nums font-semibold">{money(o.total)}</span>
                </summary>
                <div className="overflow-x-auto border-t border-border/60 bg-muted/20">
                  <table className="w-full text-sm">
                    <tbody>
                      {o.invoices.map((inv) => (
                        <tr key={inv.invoiceNumber} className="border-b border-border/40 last:border-0">
                          <td className="py-2 pl-12 pr-4 font-medium">{inv.invoiceNumber}</td>
                          <td className="px-4 py-2 tabular-nums text-muted-foreground">{inv.date}</td>
                          <td className="px-4 py-2">
                            {inv.status === "part_paid" ? (
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">part paid</span>
                            ) : null}
                          </td>
                          <td className="px-5 py-2 text-right tabular-nums">{money(inv.owing)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </li>
          ))}
        </ul>
      </div>

      {p.contractedBySupplier.length > 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-baseline justify-between border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold">Accepted quotes still to be billed</h3>
            <span className="tabular-nums text-sm text-muted-foreground">{money(p.contracted)}</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-medium">Supplier</th>
                <th className="px-5 py-2 text-right font-medium">Quoted</th>
                <th className="px-5 py-2 text-right font-medium">Invoiced</th>
                <th className="px-5 py-2 text-right font-medium">Still to come</th>
              </tr>
            </thead>
            <tbody>
              {p.contractedBySupplier.map((q) => (
                <tr key={q.supplier} className="border-b border-border/60 last:border-0">
                  <td className="px-5 py-2">{q.supplier}</td>
                  <td className="px-5 py-2 text-right tabular-nums text-muted-foreground">{money(q.quoted)}</td>
                  <td className="px-5 py-2 text-right tabular-nums text-muted-foreground">{money(q.invoiced)}</td>
                  <td className="px-5 py-2 text-right tabular-nums font-medium">{money(q.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Every drawdown, including the ones the lender paid straight to a supplier. */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-baseline justify-between border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold">Drawdowns</h3>
          <span className="tabular-nums text-sm text-muted-foreground">
            {money(p.certifiedToDate)} certified · {money(p.directPayments)} paid direct
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-medium">Event</th>
                <th className="px-5 py-2 font-medium">Date</th>
                <th className="px-5 py-2 text-right font-medium">Certified</th>
                <th className="px-5 py-2 text-right font-medium">Cash received</th>
              </tr>
            </thead>
            <tbody>
              {p.drawdowns.map((d, i) => (
                <tr key={`${d.label}-${i}`} className="border-b border-border/60 last:border-0">
                  <td className="px-5 py-2">
                    {d.label}
                    {d.direct ? (
                      <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-400">paid direct</span>
                    ) : null}
                    {d.missingCash ? (
                      <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">no cash figure</span>
                    ) : null}
                  </td>
                  <td className="px-5 py-2 tabular-nums text-muted-foreground">{d.date ?? "—"}</td>
                  <td className="px-5 py-2 text-right tabular-nums">{money(d.certified)}</td>
                  <td className="px-5 py-2 text-right tabular-nums text-muted-foreground">
                    {d.direct ? <span className="opacity-60">direct to supplier</span> : money(d.cash)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-5 py-2" colSpan={2}>Total drawn against the facility</td>
                <td className="px-5 py-2 text-right tabular-nums">{money(p.certifiedToDate)}</td>
                <td className="px-5 py-2 text-right tabular-nums text-muted-foreground">{money(p.cashReceived)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          Drawn counts what the lender <strong>certified</strong>, which includes {money(p.directPayments)} paid straight to
          suppliers and never received as cash — that money still reduces the facility. Rows marked
          &ldquo;no cash figure&rdquo; are certified with no receipt recorded, so cash-based totals understate drawings.
        </p>
      </div>
    </div>
  )
}
