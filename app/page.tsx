"use client"

import { useState } from "react"
import Link from "next/link"
import { Wallet, TrendingUp, FileSignature, Banknote, ArrowRight } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { ProjectSelector } from "@/components/project-selector"
import { MetricCard } from "@/components/metric-card"
import { AttentionItem } from "@/components/attention-item"
import { StatusBadge } from "@/components/status-badge"
import { attentionItems, getProject, projectScopes } from "@/lib/data"
import { formatGBP, formatNumber } from "@/lib/utils"

export default function DashboardPage() {
  const [scope, setScope] = useState("Portfolio")
  const higherFarm = getProject("higher-farm")!

  const filteredAttention =
    scope === "Portfolio"
      ? attentionItems
      : attentionItems.filter((item) => item.project === scope || item.project === "Portfolio")

  return (
    <>
      <PageHeader
        title="Good afternoon, Tom"
        description="Here's what needs your attention across Gilbert Build Co."
        actions={
          <ProjectSelector options={projectScopes} value={scope} onChange={setScope} />
        }
      />

      <main className="flex flex-col gap-8 px-8 py-8">
        {/* Primary commercial KPIs */}
        <section aria-labelledby="kpi-heading">
          <h2 id="kpi-heading" className="sr-only">
            Commercial key figures
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Cash Position"
              unconnected
              icon={<Wallet className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            />
            <MetricCard
              label="Forecast Development Profit"
              unconnected
              icon={<TrendingUp className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            />
            <MetricCard
              label="Committed Cost"
              unconnected
              icon={<FileSignature className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            />
            <MetricCard
              label="Next Drawdown"
              value={formatGBP(higherFarm.remainingDrawdown!, { decimals: true })}
              hint="Remaining development drawdown previously recorded · Higher Farm"
              icon={<Banknote className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            />
          </div>
        </section>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          {/* Attention Required */}
          <section aria-labelledby="attention-heading" className="xl:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="attention-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Attention Required
              </h2>
              <span className="text-xs text-muted-foreground">{filteredAttention.length} items</span>
            </div>
            <div className="rounded-lg border border-border bg-card">
              {filteredAttention.map((item) => (
                <AttentionItem key={item.id} item={item} />
              ))}
            </div>
          </section>

          {/* Project Performance */}
          <section aria-labelledby="performance-heading">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="performance-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Project Performance
              </h2>
            </div>
            <div className="flex flex-col rounded-lg border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-foreground">{higherFarm.name}</h3>
                  <p className="text-sm text-muted-foreground">{higherFarm.location}</p>
                </div>
                <StatusBadge variant="info" dot>
                  {higherFarm.status}
                </StatusBadge>
              </div>

              <dl className="mt-5 flex flex-col divide-y divide-border">
                <PerfRow label="Homes" value={`${higherFarm.homes} detached houses`} />
                <PerfRow label="Total build area" value={`${formatNumber(higherFarm.buildAreaSqFt!)} sq ft`} />
                <PerfRow label="Original build budget" value={formatGBP(higherFarm.originalBuildBudget!)} />
                <PerfRow label="Development facility" value={formatGBP(higherFarm.developmentFacility!)} />
                <PerfRow
                  label="Remaining drawdown"
                  value={formatGBP(higherFarm.remainingDrawdown!, { decimals: true })}
                />
              </dl>

              <div className="mt-4 rounded-md bg-muted/60 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">
                  Current total spend, profit and cash position are not shown until a live data source is
                  connected.
                </p>
              </div>

              <Link
                href="/projects/higher-farm"
                className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Open project
                <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
              </Link>
            </div>
          </section>
        </div>
      </main>
    </>
  )
}

function PerfRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground tabular-nums">{value}</dd>
    </div>
  )
}
