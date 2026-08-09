"use client"

import { useState } from "react"
import dynamic from "next/dynamic"
import { FileText } from "lucide-react"

// react-pdf relies on browser-only APIs, so load it lazily and skip SSR.
const InvoiceDocumentViewer = dynamic(
  () => import("./invoice-document-viewer").then((m) => m.InvoiceDocumentViewer),
  { ssr: false },
)

export interface InvoiceViewCellProps {
  fileUrl: string | null
  invoiceNumber: string | null
  supplierName: string
  pageStart: number | null
  pageEnd: number | null
}

export function InvoiceViewCell({
  fileUrl,
  invoiceNumber,
  supplierName,
  pageStart,
  pageEnd,
}: InvoiceViewCellProps) {
  const [open, setOpen] = useState(false)

  if (!fileUrl) {
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-1.5 text-primary transition-opacity hover:underline"
      >
        <FileText className="h-4 w-4" strokeWidth={1.75} />
        View invoice
      </button>
      {open ? (
        <InvoiceDocumentViewer
          fileUrl={fileUrl}
          invoiceNumber={invoiceNumber}
          supplierName={supplierName}
          pageStart={pageStart}
          pageEnd={pageEnd}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
