"use client"

import { useMemo, useState } from "react"
import { cn, formatGBP } from "@/lib/utils"
import { StatusBadge } from "@/components/status-badge"

interface Inputs {
  landPrice: number
  buildArea: number
  buildCostPerSqFt: number
  professional: number
  finance: number
  sales: number
  contingency: number
  gdv: number
  targetProfitOnGdv: number
}

// Pre-populated with known Phase 2 assumptions. Other assumptions default to
// zero and are left for the user to complete rather than invented.
const initial: Inputs = {
  landPrice: 250000,
  buildArea: 3850,
  buildCostPerSqFt: 205,
  professional: 0,
  finance: 0,
  sales: 0,
  contingency: 0,
  gdv: 1650000,
  targetProfitOnGdv: 20,
}

export function AppraisalCalculator() {
  const [inputs, setInputs] = useState<Inputs>(initial)

  const set = (key: keyof Inputs) => (value: number) =>
    setInputs((prev) => ({ ...prev, [key]: value }))

  const results = useMemo(() => {
    const buildCost = inputs.buildArea * inputs.buildCostPerSqFt
    const otherCosts = buildCost + inputs.professional + inputs.finance + inputs.sales + inputs.contingency
    const totalDevelopmentCost = inputs.landPrice + otherCosts
    const forecastProfit = inputs.gdv - totalDevelopmentCost
    const profitOnCost = totalDevelopmentCost > 0 ? (forecastProfit / totalDevelopmentCost) * 100 : 0
    const profitOnGdv = inputs.gdv > 0 ? (forecastProfit / inputs.gdv) * 100 : 0
    const targetProfit = (inputs.targetProfitOnGdv / 100) * inputs.gdv
    const residualLandValue = inputs.gdv - otherCosts - targetProfit
    return {
      buildCost,
      totalDevelopmentCost,
      forecastProfit,
      profitOnCost,
      profitOnGdv,
      residualLandValue,
    }
  }, [inputs])

  const viability: { label: string; variant: "success" | "warning" | "danger"; note: string } =
    results.profitOnCost >= 20
      ? { label: "Viable", variant: "success", note: "Profit on cost meets the 20% development benchmark." }
      : results.profitOnCost >= 15
        ? { label: "Marginal", variant: "warning", note: "Profit on cost is below the 20% benchmark." }
        : { label: "Not viable", variant: "danger", note: "Profit on cost is below acceptable risk thresholds." }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* Inputs */}
      <section className="lg:col-span-3">
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold text-foreground">Appraisal inputs</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Phase 2 known assumptions are pre-filled. All fields are editable.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-5 p-5 sm:grid-cols-2">
            <NumberField label="Land Price" prefix="£" value={inputs.landPrice} onChange={set("landPrice")} known />
            <NumberField label="Build Area" suffix="sq ft" value={inputs.buildArea} onChange={set("buildArea")} known />
            <NumberField
              label="Build Cost / sq ft"
              prefix="£"
              value={inputs.buildCostPerSqFt}
              onChange={set("buildCostPerSqFt")}
              known
            />
            <NumberField label="GDV" prefix="£" value={inputs.gdv} onChange={set("gdv")} known />
            <NumberField
              label="Professional & Statutory Costs"
              prefix="£"
              value={inputs.professional}
              onChange={set("professional")}
            />
            <NumberField label="Finance Costs" prefix="£" value={inputs.finance} onChange={set("finance")} />
            <NumberField label="Sales Costs" prefix="£" value={inputs.sales} onChange={set("sales")} />
            <NumberField label="Contingency" prefix="£" value={inputs.contingency} onChange={set("contingency")} />
            <NumberField
              label="Target Profit on GDV"
              suffix="%"
              value={inputs.targetProfitOnGdv}
              onChange={set("targetProfitOnGdv")}
            />
          </div>
        </div>
      </section>

      {/* Results */}
      <section className="lg:col-span-2">
        <div className="flex flex-col gap-4">
          <div
            className={cn("flex items-center justify-between rounded-lg border px-5 py-4", {
              "border-success/30 bg-success-bg": viability.variant === "success",
              "border-warning/30 bg-warning-bg": viability.variant === "warning",
              "border-danger/30 bg-danger-bg": viability.variant === "danger",
            })}
          >
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Viability</p>
              <p
                className={cn("text-lg font-semibold", {
                  "text-success": viability.variant === "success",
                  "text-warning": viability.variant === "warning",
                  "text-danger": viability.variant === "danger",
                })}
              >
                {viability.label}
              </p>
            </div>
            <StatusBadge variant={viability.variant} dot>
              {results.profitOnCost.toFixed(1)}% on cost
            </StatusBadge>
          </div>

          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-5 py-3.5">
              <h2 className="text-sm font-semibold text-foreground">Results</h2>
            </div>
            <dl className="flex flex-col divide-y divide-border px-5">
              <ResultRow label="Build Cost" value={formatGBP(results.buildCost)} />
              <ResultRow label="Total Development Cost" value={formatGBP(results.totalDevelopmentCost)} />
              <ResultRow
                label="Forecast Profit"
                value={formatGBP(results.forecastProfit)}
                emphasis
                positive={results.forecastProfit >= 0}
              />
              <ResultRow label="Profit on Cost" value={`${results.profitOnCost.toFixed(1)}%`} />
              <ResultRow label="Profit on GDV" value={`${results.profitOnGdv.toFixed(1)}%`} />
              <ResultRow label="Residual Land Value" value={formatGBP(results.residualLandValue)} />
            </dl>
            <div className="px-5 pb-4 pt-1">
              <p className="text-xs text-muted-foreground">{viability.note}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  prefix,
  suffix,
  known,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  prefix?: string
  suffix?: string
  known?: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
        {label}
        {known ? (
          <span className="rounded-full bg-info-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-info">
            Known
          </span>
        ) : null}
      </span>
      <div className="flex items-center rounded-md border border-border bg-card focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
        {prefix ? <span className="pl-3 text-sm text-muted-foreground">{prefix}</span> : null}
        <input
          type="number"
          inputMode="decimal"
          value={Number.isNaN(value) ? "" : value}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="h-9 w-full min-w-0 bg-transparent px-2.5 text-sm text-foreground outline-none tabular-nums"
        />
        {suffix ? <span className="pr-3 text-sm text-muted-foreground">{suffix}</span> : null}
      </div>
    </label>
  )
}

function ResultRow({
  label,
  value,
  emphasis,
  positive,
}: {
  label: string
  value: string
  emphasis?: boolean
  positive?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className={cn("text-sm", emphasis ? "font-medium text-foreground" : "text-muted-foreground")}>
        {label}
      </dt>
      <dd
        className={cn("text-sm font-semibold tabular-nums", {
          "text-success": emphasis && positive,
          "text-danger": emphasis && positive === false,
          "text-foreground": !emphasis,
        })}
      >
        {value}
      </dd>
    </div>
  )
}
