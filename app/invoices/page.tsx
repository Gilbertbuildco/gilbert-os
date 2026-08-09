import { Upload, PenLine, ReceiptText } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"

const columns = [
  "Date",
  "Supplier",
  "Invoice Number",
  "Project",
  "Cost Package",
  "Net",
  "VAT",
  "Gross",
  "Status",
]

export default function InvoicesPage() {
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Capture supplier invoices to feed both project costs and procurement price history."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <PenLine className="h-4 w-4" strokeWidth={1.75} />
              Manual Entry
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Upload className="h-4 w-4" strokeWidth={1.75} />
              Upload Invoice
            </button>
          </div>
        }
      />
      <main className="flex flex-col gap-5 px-8 py-8">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  {columns.map((col, i) => (
                    <th
                      key={col}
                      scope="col"
                      className={`px-4 py-2.5 font-semibold ${
                        ["Net", "VAT", "Gross"].includes(col) ? "text-right" : "text-left"
                      }`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={columns.length} className="p-0">
                    <EmptyState
                      className="rounded-none border-0"
                      icon={<ReceiptText className="h-5 w-5" strokeWidth={1.75} />}
                      title="No invoices recorded yet"
                      description="Upload or manually enter your first invoice. Once ingested, invoices will automatically update project cost packages and refresh procurement price history for the relevant supplier and products."
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  )
}
