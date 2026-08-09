import { PageHeader } from "@/components/page-header"
import { StatusBadge, type StatusVariant } from "@/components/status-badge"
import { suppliers, type Supplier } from "@/lib/data"

const statusVariant: Record<Supplier["status"], StatusVariant> = {
  Active: "success",
  Pending: "warning",
  Review: "danger",
}

export default function SuppliersPage() {
  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Merchant relationships and pricing coverage. Spend and credit figures populate from ingested invoices."
      />
      <main className="px-8 py-8">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {suppliers.map((supplier) => (
            <div key={supplier.name} className="flex flex-col rounded-lg border border-border bg-card p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{supplier.name}</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">{supplier.contact}</p>
                </div>
                <StatusBadge variant={statusVariant[supplier.status]} dot>
                  {supplier.status}
                </StatusBadge>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
                <Field label="Pricing coverage">
                  <StatusBadge variant={supplier.coverageVariant}>{supplier.pricingCoverage}</StatusBadge>
                </Field>
                <Field label="Last pricing update">
                  <span className="text-sm text-foreground">{supplier.lastPricingUpdate}</span>
                </Field>
                <Field label="Spend">
                  <Unconnected />
                </Field>
                <Field label="Open credits">
                  <Unconnected />
                </Field>
              </dl>
            </div>
          ))}
        </div>
      </main>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Unconnected() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" aria-hidden />
      Data connection required
    </span>
  )
}
