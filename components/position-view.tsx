import type { Position } from "@/lib/funding/position"
import { cn } from "@/lib/utils"

const money = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const money0 = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`

function Big({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "in" | "out" }) {
  return (
    <div className={cn("rounded-lg border bg-card p-5",
      tone === "in" ? "border-emerald-500/40" : tone === "out" ? "border-amber-500/40" : "border-border")}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-3xl font-semibold tabular-nums",
        tone === "out" && "text-amber-600 dark:text-amber-400")}>{value}</div>
      <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  )
}

export function PositionView({ p }: { p: Position }) {
  const short = p.headroom < 0
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Big label="In the bank" tone="in"
          value={p.cash ? money(p.cash.amount) : "—"}
          sub={p.cash ? `${p.cash.source} · ${p.cash.asAt}` : "no balance recorded"} />
        <Big label="Owed right now" tone="out" value={money(p.owedNow.total)}
          sub={`${p.owedNow.count} unpaid invoices, inc VAT`} />
        <Big label="Left to draw down" tone="in" value={money(p.leftToDraw)}
          sub={`${money0(p.facility.certified)} of ${money0(p.facility.total)} facility used`} />
        <Big label="Expected to pay" tone="out" value={money(p.future.total)}
          sub={`${money0(p.future.fromQuotes)} quoted · ${money0(p.future.fromOwner)} your figures`} />
      </div>

      <div className={cn("rounded-lg border p-5", short ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5")}>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {short ? "Short" : "Headroom"}
        </div>
        <div className={cn("mt-1 text-3xl font-semibold tabular-nums", short && "text-amber-600 dark:text-amber-400")}>
          {money(Math.abs(p.headroom))}
        </div>
        <dl className="mt-4 max-w-md space-y-1 text-sm">
          <div className="flex justify-between gap-4"><dt>In the bank</dt><dd className="tabular-nums">{money(p.cash?.amount ?? 0)}</dd></div>
          <div className="flex justify-between gap-4"><dt>plus left to draw down (one sum, whole facility)</dt><dd className="tabular-nums">{money(p.leftToDraw)}</dd></div>
          <div className="flex justify-between gap-4 text-muted-foreground"><dt>less owed right now</dt><dd className="tabular-nums">−{money(p.owedNow.total)}</dd></div>
          <div className="flex justify-between gap-4 text-muted-foreground"><dt>less expected to pay</dt><dd className="tabular-nums">−{money(p.future.total)}</dd></div>
          <div className="flex justify-between gap-4 border-t border-border/60 pt-1 font-semibold">
            <dt>{short ? "Short by" : "Headroom"}</dt><dd className="tabular-nums">{money(p.headroom)}</dd>
          </div>
        </dl>
      </div>

      {/* Where cost lands once the current bills are settled. Ex-VAT, because the
          lender's budget is — the gross figure above is what leaves the bank. */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Once what you owe is paid</h2>
          <span className="text-xs text-muted-foreground">ex-VAT, against the lender&rsquo;s budget</span>
        </div>
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-muted">
          <div className="flex h-full">
            <div className="h-full bg-violet-500" style={{ width: `${Math.min(100, (p.budgetAfterOwed.paid / p.budgetAfterOwed.budget) * 100)}%` }} />
            <div className="h-full bg-amber-400" style={{ width: `${Math.min(100, (p.budgetAfterOwed.owedNet / p.budgetAfterOwed.budget) * 100)}%` }} />
          </div>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-muted-foreground">Paid so far</dt><dd className="tabular-nums font-medium">{money(p.budgetAfterOwed.paid)}</dd></div>
          <div><dt className="text-muted-foreground">Plus owed</dt><dd className="tabular-nums font-medium">{money(p.budgetAfterOwed.owedNet)}</dd></div>
          <div><dt className="text-muted-foreground">Spend would be</dt><dd className="tabular-nums font-medium">{money(p.budgetAfterOwed.thenSpent)}</dd></div>
          <div>
            <dt className="text-muted-foreground">Left of budget</dt>
            <dd className={cn("tabular-nums font-semibold", p.budgetAfterOwed.thenLeft < 0 && "text-red-600 dark:text-red-400")}>
              {money(p.budgetAfterOwed.thenLeft)}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          Settling everything owed puts build cost at{" "}
          <strong className="text-foreground">{p.budgetAfterOwed.thenPct.toFixed(1)}%</strong> of the lender&rsquo;s
          budget, leaving {money(p.budgetAfterOwed.thenLeft)} of allowance.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-baseline justify-between border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold">Owed right now</h2>
            <span className="tabular-nums text-sm text-muted-foreground">{money(p.owedNow.total)}</span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {p.owedNow.bySupplier.map((o) => (
                <tr key={o.supplier} className="border-b border-border/60 last:border-0">
                  <td className="px-5 py-2">{o.supplier}</td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">{o.count}</td>
                  <td className="px-5 py-2 text-right tabular-nums font-medium">{money(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-baseline justify-between border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold">Expected to pay going forward</h2>
            <span className="tabular-nums text-sm text-muted-foreground">{money(p.future.total)}</span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {p.future.items.map((i) => (
                <tr key={i.supplier + i.amount} className="border-b border-border/60 last:border-0 align-top">
                  <td className="px-5 py-2">
                    <div className="font-medium">{i.supplier}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      <span className={cn("mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                        i.origin === "quote" ? "bg-sky-500/15 text-sky-700 dark:text-sky-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400")}>
                        {i.origin === "quote" ? "quoted" : "your figure"}
                      </span>
                      {i.detail}
                    </div>
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums font-medium">{money(i.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
            Only work with an accepted quote or a figure you have given me. Nothing here is estimated.
          </p>
        </div>
      </div>

      {p.noPriceYet.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-5">
          <h2 className="text-sm font-semibold">Not in &ldquo;expected to pay&rdquo; — nobody has priced these</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Lender allowance exists but nothing has been spent, quoted or allowed. Deliberately excluded from the figures
            above rather than guessed at — so the real cost to finish is higher than {money(p.future.total)} by whatever
            these come to.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {p.noPriceYet.map((n) => (
              <li key={n.description} className="flex justify-between gap-4">
                <span>{n.description}</span>
                <span className="tabular-nums text-muted-foreground">{money(n.budget)} allowed</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
