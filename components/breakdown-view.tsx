import type { Breakdown, BreakdownLine } from "@/lib/funding/breakdown"
import { cn } from "@/lib/utils"

const money = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const money0 = (n: number) =>
  `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`

/**
 * One bar per line: spent, then contracted, then allowance, stacked on the
 * budget. Over-budget lines get a full red bar so they cannot be mistaken for
 * a nearly-finished one.
 */
function Bar({ l }: { l: BreakdownLine }) {
  const over = l.left < -0.005
  const scale = Math.max(l.budget, l.spent + l.contracted + l.allowed)
  const pct = (v: number) => (scale > 0 ? Math.min(100, (v / scale) * 100) : 0)
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" title={`${money(l.spent)} spent of ${money(l.budget)}`}>
      <div className="flex h-full">
        <div className={cn("h-full", over ? "bg-red-500" : "bg-violet-500")} style={{ width: `${pct(l.spent)}%` }} />
        <div className="h-full bg-sky-500" style={{ width: `${pct(l.contracted)}%` }} />
        <div className="h-full bg-amber-400" style={{ width: `${pct(l.allowed)}%` }} />
      </div>
    </div>
  )
}

function Row({ l }: { l: BreakdownLine }) {
  const over = l.left < -0.005
  const untouched = l.spent === 0 && l.contracted === 0 && l.allowed === 0
  return (
    <tr className="border-b border-border/60 last:border-0 align-top">
      <td className="py-3 pl-5 pr-3">
        <div className="font-medium">{l.description}</div>
        <div className="mt-1.5 max-w-md"><Bar l={l} /></div>
        {(l.contracted > 0 || l.allowed > 0) && (
          <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
            {l.contracted > 0 && <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-500 align-middle" />{money0(l.contracted)} contracted</span>}
            {l.allowed > 0 && <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" />{money0(l.allowed)} allowed</span>}
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{money(l.budget)}</td>
      <td className="px-3 py-3 text-right tabular-nums">{l.spent > 0 ? money(l.spent) : <span className="text-muted-foreground">—</span>}</td>
      <td className={cn("px-5 py-3 text-right tabular-nums font-medium",
        over && "text-red-600 dark:text-red-400",
        untouched && "text-muted-foreground")}>{money(l.left)}</td>
    </tr>
  )
}

function Section({ title, lines }: { title: string; lines: BreakdownLine[] }) {
  if (!lines.length) return null
  const t = lines.reduce((a, l) => ({ b: a.b + l.budget, s: a.s + l.spent, l: a.l + l.left }), { b: 0, s: 0, l: 0 })
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="tabular-nums text-sm text-muted-foreground">
          {money0(t.s)} spent of {money0(t.b)} · {money0(t.l)} left
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pl-5 pr-3 text-left font-medium">Line</th>
              <th className="px-3 py-2 text-right font-medium">Budget</th>
              <th className="px-3 py-2 text-right font-medium">Spent</th>
              <th className="px-5 py-2 text-right font-medium">Left</th>
            </tr>
          </thead>
          <tbody>{lines.map((l) => <Row key={l.id} l={l} />)}</tbody>
        </table>
      </div>
    </div>
  )
}

export function BreakdownView({ b }: { b: Breakdown }) {
  const works = b.lines.filter((l) => l.section === "works")
  const fees = b.lines.filter((l) => l.section === "professional_fees")
  const over = b.lines.filter((l) => l.left < -0.005)
  const t = b.totals

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Budget", money(t.budget), `${b.lines.length} lines`],
          ["Spent", money(t.spent), `${((t.spent / t.budget) * 100).toFixed(1)}% of budget`],
          ["Committed on top", money(t.contracted + t.allowed), `${money0(t.contracted)} contracted, ${money0(t.allowed)} allowed`],
          ["Left", money(t.left), over.length ? `${over.length} line${over.length === 1 ? "" : "s"} over` : "none over"],
        ].map(([label, value, sub]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-4 rounded-lg border border-border bg-card px-5 py-3 text-xs text-muted-foreground">
        <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-violet-500 align-middle" />Spent</span>
        <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-sky-500 align-middle" />Contracted — signed quote, not yet invoiced</span>
        <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-amber-400 align-middle" />Allowed — your own figure, no supplier document</span>
        <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-red-500 align-middle" />Over budget</span>
      </div>

      {over.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-5">
          <h3 className="text-sm font-semibold">Over budget ({over.length})</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {over.map((l) => (
              <li key={l.id} className="flex justify-between gap-4">
                <span>{l.description}</span>
                <span className="tabular-nums font-medium text-red-600 dark:text-red-400">{money(l.left)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Works" lines={works} />
      <Section title="Professional fees" lines={fees} />

      {(b.unmappedSpend > 0 || b.unattributedCommitted.length > 0) && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-5">
          <h3 className="text-sm font-semibold">Not shown against any line above</h3>
          {b.unmappedSpend > 0 && (
            <p className="mt-2 text-sm">
              <strong className="tabular-nums">{money(b.unmappedSpend)}</strong> of confirmed spend maps to no funding
              line. It is real money out, but no line above carries it — so every &ldquo;left&rdquo; figure is that much
              too generous until it is classified.
            </p>
          )}
          {b.unattributedCommitted.length > 0 && (
            <>
              <p className="mt-3 text-sm">Committed money with no single obvious line:</p>
              <ul className="mt-1 space-y-1 text-sm">
                {b.unattributedCommitted.map((u) => (
                  <li key={u.label} className="flex justify-between gap-4">
                    <span>{u.label} <span className="text-xs text-muted-foreground">({u.kind})</span></span>
                    <span className="tabular-nums">{money(u.amount)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
