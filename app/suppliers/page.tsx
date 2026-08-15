import { Building2 } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { getSuppliers } from "@/lib/queries"
import { formatGBP } from "@/lib/utils"

export const dynamic = "force-dynamic"

function formatDate(d: string | null) {
  if (!d) return "No invoices yet"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export default async function SuppliersPage() {
  const suppliers = await getSuppliers()

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Merchant relationships built automatically from ingested invoices. Spend, product coverage and last activity update as invoices are captured."
      />
      <main className="px-4 py-8 sm:px-8">
        {suppliers.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-5 w-5" strokeWidth={1.75} />}
            title="No suppliers yet"
            description="Suppliers are created automatically the first time you upload an invoice from them. Once captured, their spend and pricing coverage appear here."
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {suppliers.map((supplier) => (
              <div key={supplier.id} className="flex flex-col rounded-lg border border-border bg-card p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">{supplier.name}</h2>
                    {supplier.contact ? (
                      <p className="mt-0.5 text-sm text-muted-foreground">{supplier.contact}</p>
                    ) : null}
                  </div>
                </div>

                <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
                  <Field label="Total spend" value={formatGBP(supplier.totalSpend)} />
                  <Field label="Invoices" value={String(supplier.invoiceCount)} />
                  <Field label="Products priced" value={String(supplier.productCount)} />
                  <Field label="Last invoice" value={formatDate(supplier.lastInvoiceDate)} />
                </dl>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground tabular-nums">{value}</dd>
    </div>
  )
}
