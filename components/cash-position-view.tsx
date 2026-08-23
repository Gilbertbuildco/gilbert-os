import type { CashPosition } from "@/lib/funding/cash-position"
import { cn } from "@/lib/utils"

const money = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const money0 = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "plain" }) {
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

/** Two bars on the same scale, so "drawn vs committed" is a visual comparison rather than two numbers to subtract mentally. */
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
  const short = p.headroom < 0
  return (
    <div className="flex flex-col gap-6">
      {/* The headline answer: does the money left to draw cover the money left to spend? */}
      <div className={cn("rounded-lg border p-5",
        short ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5")}>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {short ? "Remaining budget exceeds remaining funding" : "Remaining funding covers remaining budget"}
        </div>
        <div className={cn("mt-1 text-3xl font-semibold tabular-nums",
          short ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400")}>
          {short ? "Short by " : "Ahead by "}{money(Math.abs(p.headroom))}
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          {money(p.leftToDraw)} left to draw against {money(p.leftToSpend)} left to spend.
          {short
            ? " Spending the full remaining budget would need that difference from your own cash, unless favourable variances close it."
            : " The facility covers what is left in the budget."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Left to draw" value={money(p.leftToDraw)} sub={`${money0(p.certifiedToDate)} certified of ${money0(p.facility)}`} />
        <Stat label="Left to spend" value={money(p.leftToSpend)} sub={`${money0(p.committed)} committed of ${money0(p.fundingBudget)}`} />
        <Stat label="Outstanding invoices" value={money(p.outstanding)} sub={`${p.outstandingCount} unpaid or part paid`} tone="bad" />
        <Stat label="Spent to date" value={money(p.spentToDate)} sub="confirmed invoices" />
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
        <h3 className="text-sm font-semibold">Drawn against spent</h3>
        <Bar label="Drawn from the facility" pct={p.drawnPct} amount={p.certifiedToDate} total={p.facility} className="bg-sky-500" />
        <Bar label="Committed cost" pct={p.committedPct} amount={p.committed} total={p.fundingBudget} className="bg-violet-500" />
        <p className="text-xs text-muted-foreground">
          Drawn counts what the lender has <strong>certified</strong>, including {money(p.directPayments)} paid direct to
          suppliers that never reached your account — that money still reduces the facility. Committed is spend to date
          plus everything currently owed.
        </p>
      </div>

      {p.eventsMissingCash.length > 0 ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
          <h3 className="text-sm font-semibold">Certified with no cash figure recorded</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            These are certified against the facility but carry no receipt amount, so cash-based totals understate drawings.
            Worth confirming what actually landed.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {p.eventsMissingCash.map((e) => (
              <li key={e.label} className="flex justify-between gap-4">
                <span>{e.label}</span><span className="tabular-nums">{money(e.certified)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold">What you owe right now</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-medium">Supplier</th>
                <th className="px-5 py-2 font-medium">Invoice</th>
                <th className="px-5 py-2 font-medium">Date</th>
                <th className="px-5 py-2 text-right font-medium">Owing</th>
              </tr>
            </thead>
            <tbody>
              {p.topOutstanding.map((o) => (
                <tr key={`${o.supplier}-${o.invoiceNumber}`} className="border-b border-border/60 last:border-0">
                  <td className="px-5 py-2">{o.supplier}</td>
                  <td className="px-5 py-2 text-muted-foreground">{o.invoiceNumber}</td>
                  <td className="px-5 py-2 tabular-nums text-muted-foreground">{o.date}</td>
                  <td className="px-5 py-2 text-right tabular-nums font-medium">{money(o.owing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {p.outstandingCount > p.topOutstanding.length ? (
          <div className="border-t border-border px-5 py-2 text-xs text-muted-foreground">
            Showing the {p.topOutstanding.length} largest of {p.outstandingCount}.
          </div>
        ) : null}
      </div>
    </div>
  )
}
