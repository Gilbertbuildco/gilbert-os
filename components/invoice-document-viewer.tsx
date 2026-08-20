"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Document, Page, pdfjs } from "react-pdf"
import "react-pdf/dist/Page/AnnotationLayer.css"
import "react-pdf/dist/Page/TextLayer.css"
import {
  ArrowLeft,
  X,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  FileWarning,
} from "lucide-react"

// Load the pdf.js worker from the bundled dependency (no external CDN, so it
// keeps working behind strict CSP and offline).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString()

export interface InvoiceDocumentViewerProps {
  /** Public URL of the ORIGINAL source file (may contain other invoices). */
  fileUrl: string
  invoiceNumber: string | null
  supplierName: string
  /** 1-based inclusive page range this invoice occupies, or null if unknown. */
  pageStart: number | null
  pageEnd: number | null
  onClose: () => void
}

export function InvoiceDocumentViewer({
  fileUrl,
  invoiceNumber,
  supplierName,
  pageStart,
  pageEnd,
  onClose,
}: InvoiceDocumentViewerProps) {
  const [numPages, setNumPages] = useState<number | null>(null)
  // Not every stored document is a PDF — invoices arrive as photos (png/jpg) and
  // Word files too. react-pdf can only render PDFs, so anything else gets an
  // image view or a download link rather than a silent failure.
  const kind = ((): "pdf" | "image" | "other" => {
    const src = (fileUrl ?? "").toLowerCase().split("?")[0]
    if (/\.(png|jpe?g|gif|webp|heic)$/.test(src)) return "image"
    if (/\.pdf$/.test(src)) return "pdf"
    return src ? "other" : "pdf"
  })()
  const [loadError, setLoadError] = useState(false)
  const [containerWidth, setContainerWidth] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Resolve the exact set of pages that belong to THIS invoice. When the range
  // is unknown (older records) we fall back to the whole document so the user
  // still sees something rather than a blank screen.
  const pages = useMemo(() => {
    if (numPages == null) return []
    const start = pageStart != null ? Math.max(1, pageStart) : 1
    const end = pageEnd != null ? Math.min(numPages, pageEnd) : numPages
    const safeStart = Math.min(start, numPages)
    const safeEnd = Math.max(safeStart, end)
    const list: number[] = []
    for (let p = safeStart; p <= safeEnd; p++) list.push(p)
    return list.length > 0 ? list : [1]
  }, [numPages, pageStart, pageEnd])

  const [index, setIndex] = useState(0)
  const currentPage = pages[index]
  const hasMultiplePages = pages.length > 1

  // Intercept the device/browser Back button so it dismisses the viewer and
  // returns the user to exactly where they came from (e.g. the invoices list),
  // instead of navigating away to the previous page. We push a throwaway
  // history entry on open; a `popstate` (Back) then just closes the overlay.
  // Header Close/Back and Escape unwind the same entry via history.back() so
  // history never accumulates orphaned states.
  const closingRef = useRef(false)
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    // If we pushed a state, step back over it; the popstate handler is a no-op
    // once closingRef is set, and React unmounts us via onClose.
    if (typeof window !== "undefined" && window.history.state?.invoiceViewer) {
      window.history.back()
    }
    onClose()
  }, [onClose])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.history.pushState({ invoiceViewer: true }, "")
    const onPop = () => {
      // Back was pressed while the viewer is open: close it (we're already
      // back on the underlying page) without navigating further.
      closingRef.current = true
      onClose()
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close on Escape and lock background scroll while the overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose()
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, pages.length - 1))
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0))
    }
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [requestClose, pages.length])

  // Track the available width so pages scale to fit on phones and tablets.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setContainerWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pageWidth = useMemo(() => {
    if (!containerWidth) return undefined
    // Leave gutters and cap the width on large screens for readability.
    return Math.min(containerWidth - 32, 900)
  }, [containerWidth])

  const onDocumentLoad = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages)
    setLoadError(false)
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      role="dialog"
      aria-modal="true"
      aria-label={`Invoice ${invoiceNumber ?? ""} document`}
    >
      {/* Sticky header — stays visible while scrolling on iPad / mobile */}
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-card px-3 py-2.5 sm:px-5">
        <button
          type="button"
          onClick={requestClose}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2} />
          <span className="hidden sm:inline">Back to invoices</span>
          <span className="sm:hidden">Back</span>
        </button>

        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-semibold text-foreground">
            {invoiceNumber ? `Invoice ${invoiceNumber}` : "Invoice document"}
          </p>
          <p className="truncate text-xs text-muted-foreground">{supplierName}</p>
        </div>

        <button
          type="button"
          onClick={requestClose}
          aria-label="Close"
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span className="hidden sm:inline">Close</span>
          <X className="h-5 w-5" strokeWidth={2} />
        </button>
      </header>

      {/* Scrollable document area */}
      <div ref={scrollRef} className="flex-1 overflow-auto bg-muted/40 px-4 py-6">
        {loadError ? (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-16 text-center">
            <FileWarning className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
            <p className="text-sm text-muted-foreground">
              This document could not be displayed.{" "}
              <a
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:underline"
              >
                Open the original file
              </a>
              .
            </p>
          </div>
        ) : kind === "image" ? (
          <div className="flex flex-col items-center">
            <img
              src={fileUrl ?? ""}
              alt={`${supplierName} invoice ${invoiceNumber ?? ""}`.trim()}
              className="max-h-[70vh] w-auto max-w-full rounded-lg border border-border bg-card shadow-sm"
            />
          </div>
        ) : kind === "other" ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              This document is a {(fileUrl ?? "").split("?")[0].split(".").pop()?.toUpperCase() || "file"} and cannot be previewed here.
            </p>
            <a
              href={fileUrl ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary hover:underline"
            >
              Open the original file
            </a>
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <Document
              file={fileUrl}
              onLoadSuccess={onDocumentLoad}
              onLoadError={() => setLoadError(true)}
              loading={
                <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  Loading document…
                </div>
              }
            >
              {currentPage ? (
                <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
                  <Page
                    pageNumber={currentPage}
                    width={pageWidth}
                    renderAnnotationLayer={false}
                    renderTextLayer={false}
                  />
                </div>
              ) : null}
            </Document>
          </div>
        )}
      </div>

      {/* In-invoice page navigation — only across pages of THIS invoice */}
      {hasMultiplePages && !loadError ? (
        <footer className="sticky bottom-0 z-10 flex items-center justify-center gap-4 border-t border-border bg-card px-4 py-2.5">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(i - 1, 0))}
            disabled={index === 0}
            className="inline-flex min-h-11 items-center gap-1 rounded-md px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
            Prev
          </button>
          <span className="text-xs font-medium tabular-nums text-muted-foreground">
            Page {index + 1} of {pages.length}
          </span>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(i + 1, pages.length - 1))}
            disabled={index === pages.length - 1}
            className="inline-flex min-h-11 items-center gap-1 rounded-md px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
          >
            Next
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </button>
        </footer>
      ) : null}

      {/* Original-file access, kept separate from the scoped invoice view */}
      <div className="flex items-center justify-center border-t border-border bg-card px-4 py-2">
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} />
          View original source file
        </a>
      </div>
    </div>
  )
}
