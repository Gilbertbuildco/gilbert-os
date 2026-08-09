import { readFileSync } from "node:fs"
import { NextResponse } from "next/server"
import { commitInvoice } from "@/app/actions/invoices"
import { extractDocumentsFromFile } from "@/lib/invoice-extraction"

// TEMPORARY verification route — exercises the real ingestion pipeline inside
// the Next.js runtime (the browser test harness can't POST multipart uploads).
// Deleted immediately after verification.
export const maxDuration = 60

export async function GET() {
  const bytes = readFileSync("/vercel/share/v0-project/.v0/Bradfords-Real.pdf")
  const file = new File([bytes], "Bradfords-Test-Invoice.pdf", { type: "application/pdf" })

  const extraction = await extractDocumentsFromFile(file)
  if (!extraction.ok) {
    return NextResponse.json({ stage: "extract", ok: false, error: extraction.error })
  }

  const committed: any[] = []
  for (const doc of extraction.documents) {
    const res = await commitInvoice({
      supplierId: null,
      newSupplierName: doc.supplierName,
      projectId: 1, // Higher Farm
      invoiceNumber: doc.invoiceNumber,
      invoiceDate: doc.invoiceDate,
      transactionType: doc.transactionType,
      net: doc.totals?.net ?? 0,
      vat: doc.totals?.vat ?? 0,
      gross: doc.totals?.gross ?? 0,
      sourceFileName: extraction.fileName,
      sourceFilePathname: extraction.sourceFilePathname,
      notes: null,
      lineItems: (doc.lineItems ?? []).map((li) => ({
        description: li.description ?? "",
        quantity: li.quantity ?? null,
        unit: li.unit ?? null,
        unitPriceExVat: li.unitPriceExVat ?? null,
        lineNet: li.lineNet ?? (li.quantity && li.unitPriceExVat ? li.quantity * li.unitPriceExVat : 0),
        vatRate: li.vatRate ?? 20,
        costPackageId: null,
        productId: null,
        trackAsProduct: true,
        newProductCategory: null,
      })),
    })
    committed.push(res)
  }

  return NextResponse.json({
    ok: true,
    detected: extraction.documents.length,
    sourceRetained: extraction.sourceFilePathname,
    committed,
  })
}
