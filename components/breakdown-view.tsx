import type { Breakdown, BreakdownLine } from "@/lib/funding/breakdown"
import { cn } from "@/lib/utils"

const money = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const money0 = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`

function Headline({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "warn" && "text-amber-600 dark:text-amber-400")}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  )
}

/** Drawn above, paid below, on one budget scale — so drawing ahead of cost is visible as an overhang. */
function DualBar({ l }: { l: BreakdownLine }) {
  const scale = Math.max(l.budget, l.spent, l.drawn ?? 0)
  const pct = (v: number) => (scale > 0 ? Math.min(100, (v / scale) * 100) : 0)
  const overspent = l.spent > l.budget + 0.005
  return (
    <div className="max-w-sm space-y-1">
      <div className="flex items-center gap-2">
        <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">drawn</span>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          {l.drawn != null && <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct(l.drawn)}%` }} />}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">spent</span>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full", overspent ? "bg-red-500" : "bg-violet-500")} style={{ width: `${pct(l.spent)}%` }} />
        </div>
      </div>
    </div>
  )
}

function Section({ title, lines }: { title: string; lines: BreakdownLine[] }) {
  if (!lines.length) return null
  const t = lines.reduce((a, l) => ({
    b: a.b + l.budget, s: a.s + l.spent, d: a.d + (l.drawn ?? 0), ls: a.ls + l.leftToSpend,
  }), { b: 0, s: 0, d: 0, ls: 0 })
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="tabular-nums text-sm text-muted-foreground">
          {money0(t.d)} drawn · {money0(t.s)} spent · {money0(t.ls)} left to spend
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pl-5 pr-3 text-left font-medium">Line</th>
              <th className="px-3 py-2 text-right font-medium">Budget</th>
              <th className="px-3 py-2 text-right font-medium">Drawn</th>
              <th className="px-3 py-2 text-right font-medium">Spent</th>
              <th className="px-3 py-2 text-right font-medium">Left to spend</th>
              <th className="px-5 py-2 text-right font-medium">Left to draw</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const overspent = l.leftToSpend < -0.005
              return (
                <tr key={l.id} className="border-b border-border/60 last:border-0 align-top">
                  <td className="py-3 pl-5 pr-3">
                    <div className="font-medium">{l.description}</div>
                    <div className="mt-1.5"><DualBar l={l} /></div>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{money(l.budget)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {l.drawn == null ? <span className="text-muted-foreground">—</span> : money(l.drawn)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {l.spent > 0 ? money(l.spent) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className={cn("px-3 py-3 text-right tabular-nums font-medium", overspent && "text-red-600 dark:text-red-400")}>
                    {money(l.leftToSpend)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                    {l.leftToDraw == null ? "—" : money(l.leftToDraw)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function BreakdownView({ b }: { b: Breakdown }) {
  const works = b.lines.filter((l) => l.section === "works")
  const fees = b.lines.filter((l) => l.section === "professional_fees")
  const over = b.lines.filter((l) => l.leftToSpend < -0.005)
  const t = b.totals

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Headline label="Drawn" value={money(b.facility.certified)}
          sub={`of ${money0(b.facility.total)} facility · ${((b.facility.certified / b.facility.total) * 100).toFixed(1)}%`} />
        <Headline label="Spent" value={money(t.spent)}
          sub={`${((t.spent / t.budget) * 100).toFixed(1)}% of budget · paid invoices only`} />
        <Headline label="Left to spend" value={money(t.budget - t.spent)} sub="budget not yet paid out against" />
        <Headline label="Left to draw" value={money(b.facility.leftToDraw)} sub="facility still available" />
      </div>

      {/* Cash in vs cash out, gross. The per-line figures are a narrower measure
          (build-cost, mapped, ex-VAT, paid) and must never be compared with total
          drawings — doing so implied £284k in hand against a £10k balance. */}
      <div className={cn("rounded-lg border p-5", b.cash.net >= 0 ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5")}>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {b.cash.net >= 0 ? "Lender money received but not yet spent" : "Spent beyond what the lender has released"}
        </div>
        <div className="mt-1 text-3xl font-semibold tabular-nums">{money(Math.abs(b.cash.net))}</div>
        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex justify-between gap-4"><dt>Certified by the lender</dt><dd className="tabular-nums">{money(b.cash.certified)}</dd></div>
          <div className="flex justify-between gap-4 text-muted-foreground">
            <dt>less paid direct to suppliers</dt><dd className="tabular-nums">−{money(b.cash.paidDirect)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-border/60 pt-1 font-medium">
            <dt>Cash received</dt><dd className="tabular-nums">{money(b.cash.received)}</dd>
          </div>
          <div className="flex justify-between gap-4"><dt>Cash paid out on invoices</dt><dd className="tabular-nums">−{money(b.cash.paidOut)}</dd></div>
          <div className="flex justify-between gap-4 border-t border-border/60 pt-1 font-semibold">
            <dt>Net</dt><dd className="tabular-nums">{money(b.cash.net)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          Gross, and every payment whatever its classification — so this is comparable with the bank. The per-line
          figures below are narrower: build cost only, mapped to a funding line, ex-VAT. Do not compare those with
          total drawings.
        </p>
      </div>

      <div className="flex flex-wrap gap-4 rounded-lg border border-border bg-card px-5 py-3 text-xs text-muted-foreground">
        <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-emerald-500 align-middle" />Drawn from the lender</span>
        <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-violet-500 align-middle" />Spent — money actually paid out</span>
        <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-red-500 align-middle" />Spent beyond budget</span>
        <span className="opacity-70">A cost counts here only once it has been paid. Unpaid invoices are bills to pay, on Cash Position.</span>
      </div>

      {over.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-5">
          <h3 className="text-sm font-semibold">Spent beyond budget ({over.length})</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {over.map((l) => (
              <li key={l.id} className="flex justify-between gap-4">
                <span>{l.description}</span>
                <span className="tabular-nums font-medium text-red-600 dark:text-red-400">{money(l.leftToSpend)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Works" lines={works} />
      <Section title="Professional fees" lines={fees} />

      {(b.unmappedSpend > 0 || b.linesWithoutDrawdown > 0) && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-5 text-sm">
          <h3 className="font-semibold">Worth knowing when reading the lines above</h3>
          {b.unmappedSpend > 0 && (
            <p className="mt-2">
              <strong className="tabular-nums">{money(b.unmappedSpend)}</strong> of paid spend maps to no funding
              line, so no line below carries it and every &ldquo;left to spend&rdquo; is that much too generous.
            </p>
          )}
          {b.linesWithoutDrawdown > 0 && (
            <p className="mt-2">
              {b.linesWithoutDrawdown} of {b.lines.length} lines carry no drawdown allocation, so per-line
              &ldquo;drawn&rdquo; is incomplete. The facility totals at the top come from the drawdown certificates
              themselves and are the reliable figures.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
