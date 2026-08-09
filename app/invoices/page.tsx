import Link from "next/link"
import { Upload, ReceiptText, FileText } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { getInvoices } from "@/lib/queries"
import { formatGBP } from "@/lib/utils"

export const dynamic = "force-dynamic"

function formatDate(d: string | null) {
  if (!d) return "—"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return d
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export default async function InvoicesPage() {
  const invoices = await getInvoices()

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Capture supplier invoices to feed both project costs and procurement price history."
        actions={
          <Link
            href="/invoices/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Upload className="h-4 w-4" strokeWidth={1.75} />
            Upload Invoice
          </Link>
        }
      />
      <main className="flex flex-col gap-5 px-8 py-8">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-4 py-2.5 text-left font-semibold">Date</th>
                  <th scope="col" className="px-4 py-2.5 text-left font-semibold">Supplier</th>
                  <th scope="col" className="px-4 py-2.5 text-left font-semibold">Invoice No.</th>
                  <th scope="col" className="px-4 py-2.5 text-left font-semibold">Project</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Lines</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Net</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">VAT</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Gross</th>
                  <th scope="col" className="px-4 py-2.5 text-left font-semibold">Type</th>
                  <th scope="col" className="px-4 py-2.5 text-left font-semibold">Source</th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-0">
                      <EmptyState
                        className="rounded-none border-0"
                        icon={<ReceiptText className="h-5 w-5" strokeWidth={1.75} />}
                        title="No invoices recorded yet"
                        description="Upload your first invoice. Once ingested, invoices automatically update project cost packages and refresh procurement price history for the relevant supplier and products."
                        action={
                          <Link
                            href="/invoices/new"
                            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                          >
                            <Upload className="h-4 w-4" strokeWidth={1.75} />
                            Upload Invoice
                          </Link>
                        }
                      />
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv) => (
                    <tr key={inv.id} className="border-b border-border last:border-b-0">
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {formatDate(inv.invoiceDate)}
                      </td>
                      <td className="px-4 py-3 font-medium text-foreground">{inv.supplierName}</td>
                      <td className="px-4 py-3 text-muted-foreground">{inv.invoiceNumber ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{inv.projectName ?? "Unassigned"}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        {inv.lineItemCount}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatGBP(inv.net, { decimals: true })}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatGBP(inv.vat, { decimals: true })}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">
                        {formatGBP(inv.gross, { decimals: true })}
                      </td>
                      <td className="px-4 py-3">
                        {inv.transactionType === "credit" ? (
                          <StatusBadge variant="warning">Credit</StatusBadge>
                        ) : (
                          <StatusBadge variant="success">Invoice</StatusBadge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {inv.sourceFilePathname ? (
                          <a
                            href={inv.sourceFilePathname}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-primary hover:underline"
                          >
                            <FileText className="h-4 w-4" strokeWidth={1.75} />
                            View
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  )
}
