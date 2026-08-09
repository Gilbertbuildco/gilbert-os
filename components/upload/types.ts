import type { DuplicateVerdict } from "@/lib/duplicate-detection"

export type ProjectOption = { id: number; name: string; slug: string }
export type SupplierOption = { id: number; name: string }
export type PackageOption = { id: number; code: string | null; name: string }

export interface DraftLine {
  description: string
  quantity: string
  unit: string
  unitPriceExVat: string
  lineNet: string
  vatRate: string
  costPackageId: string
  trackAsProduct: boolean
  productCategory: string
}

/** One uploaded source file, retained in Blob storage. */
export interface SourceFile {
  fileName: string
  sourceFilePathname: string | null
  sourceFileHash: string | null
}

/** How a document should be handled at commit time. */
export type Disposition =
  | "include" // will be committed
  | "skip" // excluded from commit (default for already-imported / user choice)

/** The per-document outcome recorded after the batch commit, for the summary. */
export type CommitOutcome = "committed" | "duplicate_skipped" | "skipped" | "failed"

export interface Draft {
  sourceIndex: number
  supplierId: string
  newSupplierName: string
  projectId: string
  invoiceNumber: string
  invoiceDate: string
  transactionType: "invoice" | "credit"
  net: string
  vat: string
  gross: string
  notes: string
  pageStart: number | null
  pageEnd: number | null
  lines: DraftLine[]
  verdict: DuplicateVerdict
  disposition: Disposition
  /** For possible-duplicates: the user explicitly confirmed it is NOT a duplicate. */
  confirmedNew: boolean
  outcome: CommitOutcome | null
}
