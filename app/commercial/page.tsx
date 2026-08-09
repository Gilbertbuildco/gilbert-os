import { PageHeader } from "@/components/page-header"
import { DataTable, type Column } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { costPlan, type CostLine } from "@/lib/data"

const unconnectedCell = <span className="text-muted-foreground">—</span>

const columns: Column<CostLine>[] = [
  {
    key: "code",
    header: "Cost Code",
    render: (row) => <span className="font-mono text-xs text-muted-foreground">{row.code}</span>,
  },
  {
    key: "package",
    header: "Package",
    render: (row) => <span className="font-medium text-foreground">{row.package}</span>,
  },
  { key: "budget", header: "Original Budget", align: "right", render: () => unconnectedCell },
  { key: "committed", header: "Committed", align: "right", render: () => unconnectedCell },
  { key: "paid", header: "Paid", align: "right", render: () => unconnectedCell },
  { key: "forecast", header: "Forecast Final Cost", align: "right", render: () => unconnectedCell },
  { key: "variance", header: "Variance", align: "right", render: () => unconnectedCell },
  {
    key: "status",
    header: "Status",
    render: () => <StatusBadge variant="neutral">Not connected</StatusBadge>,
  },
]

export default function CommercialPage() {
  return (
    <>
      <PageHeader
        title="Commercial"
        description="Cost plan structure across all packages. Budget, committed and paid values populate once invoice ingestion and budgets are connected."
      />
      <main className="flex flex-col gap-5 px-8 py-8">
        <div className="rounded-lg border border-info-bg bg-info-bg/60 px-4 py-3">
          <p className="text-sm text-info">
            Cost plan framework is ready. Actual spend values are intentionally left unconnected until
            invoice data and package budgets are imported — no figures are estimated.
          </p>
        </div>

        <DataTable
          columns={columns}
          data={costPlan}
          getRowKey={(row) => row.code}
          caption="Commercial cost plan by package"
        />
      </main>
    </>
  )
}
