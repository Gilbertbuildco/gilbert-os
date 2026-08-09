import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { InvoiceUploader } from "@/components/invoice-uploader"
import { getProjectOptions } from "@/lib/queries"
import { db } from "@/lib/db"
import { suppliers as suppliersTable } from "@/lib/db/schema"
import { asc } from "drizzle-orm"

export const dynamic = "force-dynamic"

export default async function NewInvoicePage() {
  const [projects, supplierRows] = await Promise.all([
    getProjectOptions(),
    db.select().from(suppliersTable).orderBy(asc(suppliersTable.name)),
  ])

  return (
    <>
      <PageHeader
        title="Upload invoice"
        description="Read a supplier document automatically, then review before it updates your costs and price history."
        actions={
          <Link
            href="/invoices"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            Back
          </Link>
        }
      />
      <InvoiceUploader
        projects={projects}
        suppliers={supplierRows.map((s) => ({ id: s.id, name: s.name }))}
      />
    </>
  )
}
