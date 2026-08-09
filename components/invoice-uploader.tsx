"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Upload, Loader2, Trash2, Plus, FileText, Check, ChevronRight } from "lucide-react"
import { cn, formatGBP } from "@/lib/utils"
import { commitInvoice, type CommitLineItem } from "@/app/actions/invoices"
import {
  prepareBatch,
  suggestPackagesForProject,
  type DocIntelligence,
} from "@/app/actions/enrichment"
import type { ExtractedInvoice, ExtractionResult } from "@/lib/invoice-extraction"
import type { DuplicateVerdict } from "@/lib/duplicate-detection"
import { fetchCostPackages } from "@/app/actions/lookups"
import { ExtractionQueue, type QueueSnapshot } from "@/lib/extraction-queue"
import { BatchProgress, type FileProgress, type QueuePhase } from "@/components/upload/batch-progress"
import { DuplicateNotice } from "@/components/upload/duplicate-notice"
import { BatchSummary, type BatchSummaryData } from "@/components/upload/batch-summary"
import type { ExistingInvoiceRef } from "@/lib/duplicate-detection"

// One document's final disposition in a batch, kept raw so the summary screen
// can aggregate totals however it likes.
type BatchOutcome = {
  label: string
  supplierName: string
  invoiceNumber: string | null
  transactionType: "invoice" | "credit"
  net: number
  gross: number | null
  priceLines: number
  result: "imported" | "duplicate" | "skipped" | "failed"
  reason: string | null
  existing: ExistingInvoiceRef | null
}

type ProjectOption = { id: number; name: string; slug: string }
type SupplierOption = { id: number; name: string }
type PackageOption = { id: number; code: string | null; name: string }

// Paid-tier ingestion. With paid AI Gateway capacity the provider sustains far
// higher throughput (measured: 30 concurrent requests with zero rate-limiting),
// so we process a few files in parallel with light spacing for speed. The queue
// keeps its full safety net: on any 429/quota response it still pauses the whole
// batch, honours retry-after and auto-retries, so if a limit is ever reached it
// degrades gracefully instead of failing files. See lib/extraction-queue.ts.
const QUEUE_CONFIG = {
  concurrency: 4,
  minSpacingMs: 300,
} as const

interface DraftLine {
  description: string
  quantity: string
  unit: string
  unitPriceExVat: string
  lineNet: string
  vatRate: string
  costPackageId: string
  trackAsProduct: boolean
  productCategory: string
  // --- intelligence (populated by the enrichment pass, all optional) ---
  normalisedUnit?: string | null
  unitConfident?: boolean
  trackReason?: string
  trackConfidence?: "high" | "medium" | "low"
  manufacturer?: string | null
  productType?: string | null
  productFamily?: string | null
  dimensions?: string | null
  thickness?: string | null
  normalisedName?: string
  subcategory?: string | null
  // learned/suggested cost-package context
  learnedPackageCode?: string | null
  learnedPackageName?: string | null
  suggestedPackageId?: string
  suggestConfidence?: "high" | "medium" | "low" | "none"
  packageFromMemory?: boolean
  /** true once the user has explicitly chosen or accepted a cost package. */
  packageConfirmed?: boolean
}

interface Draft {
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
  // Per-document source metadata — batch uploads mix documents from several
  // files, so this cannot be a single top-level value.
  sourceFileName: string | null
  sourceFilePathname: string | null
  sourceFileHash: string | null
  // Duplicate classification for this document (null while unknown).
  verdict: DuplicateVerdict | null
  // For a possible-duplicate, the user must tick "import anyway" before commit.
  confirmedNew: boolean
  // --- intelligence ---
  // Fuzzy supplier match against existing suppliers/aliases.
  supplierMatch: SupplierMatchInfo | null
  // Original AI extraction retained for audit + model self-reported confidence.
  extractionRaw: unknown
  confidence: "high" | "medium" | "low" | null
  // Arithmetic reconciliation result for the header totals vs the lines.
  reconciled: boolean
  reconIssues: string[]
  lines: DraftLine[]
}

type SupplierMatchInfo = {
  supplierId: number | null
  supplierName: string | null
  status: "exact" | "strong" | "weak" | "none"
  score: number
}

const emptyLine: DraftLine = {
  description: "",
  quantity: "",
  unit: "",
  unitPriceExVat: "",
  lineNet: "",
  vatRate: "20",
  costPackageId: "",
  trackAsProduct: true,
  productCategory: "",
}

interface Props {
  projects: ProjectOption[]
  suppliers: SupplierOption[]
}

export function InvoiceUploader({ projects, suppliers }: Props) {
  const router = useRouter()
  const [step, setStep] = useState<"upload" | "reading" | "review" | "summary">("upload")
  const [extracting, setExtracting] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [packages, setPackages] = useState<PackageOption[]>([])
  // Which document index the exception filter is limiting the nav to.
  const [filter, setFilter] = useState<"all" | "attention" | "ready">("all")
  // Per-file progress shown while a batch is being read.
  const [fileProgress, setFileProgress] = useState<FileProgress[]>([])
  const [processedCount, setProcessedCount] = useState(0)
  // Final per-document outcomes shown on the summary screen.
  const [outcomes, setOutcomes] = useState<BatchOutcome[]>([])
  // When a file contains several documents we hold them all here and step
  // through one at a time. `drafts` is the working copy for each document and
  // `saved` marks which have already been committed to the database.
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [saved, setSaved] = useState<boolean[]>([])
  const [current, setCurrent] = useState(0)
  const [saving, startSaving] = useTransition()
  // Reading finished (all files attempted) — enables the failure actions.
  const [readingDone, setReadingDone] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // Live queue telemetry for the progress UI (throttling/backoff messaging).
  const [queuePhase, setQueuePhase] = useState<QueuePhase>("idle")
  const [resumeInMs, setResumeInMs] = useState(0)
  const [quotaBlocked, setQuotaBlocked] = useState(false)
  // The original File objects for the current batch, kept so failed files can
  // be retried WITHOUT the user re-uploading the whole batch.
  const batchFilesRef = useRef<File[]>([])
  // The single quota-aware queue driving the current batch. Holds each file's
  // successful result so a document that has been read is NEVER re-read, even
  // across automatic pauses or a manual retry pass.
  const queueRef = useRef<ExtractionQueue<Draft[]> | null>(null)

  const draft = drafts[current] ?? null
  const total = drafts.length
  const savedCount = saved.filter(Boolean).length

  function setDraft(next: Draft) {
    setDrafts((prev) => prev.map((d, i) => (i === current ? next : d)))
  }

  function draftFromDocument(
    d: ExtractedInvoice,
    source: { fileName: string | null; pathname: string | null; hash: string | null },
  ): Draft {
    return {
      supplierId: "",
      newSupplierName: d.supplierName ?? "",
      projectId: "",
      invoiceNumber: d.invoiceNumber ?? "",
      invoiceDate: d.invoiceDate ?? "",
      transactionType: d.transactionType ?? "invoice",
      net: d.totals?.net != null ? String(d.totals.net) : "",
      vat: d.totals?.vat != null ? String(d.totals.vat) : "",
      gross: d.totals?.gross != null ? String(d.totals.gross) : "",
      notes: "",
      pageStart: d.pageStart ?? null,
      pageEnd: d.pageEnd ?? d.pageStart ?? null,
      sourceFileName: source.fileName,
      sourceFilePathname: source.pathname,
      sourceFileHash: source.hash,
      verdict: null,
      confirmedNew: false,
      supplierMatch: null,
      extractionRaw: d,
      confidence: d.confidence ?? null,
      reconciled: true,
      reconIssues: [],
      lines: (d.lineItems ?? []).map((li) => ({
        description: li.description ?? "",
        quantity: li.quantity != null ? String(li.quantity) : "",
        unit: li.unit ?? "",
        unitPriceExVat: li.unitPriceExVat != null ? String(li.unitPriceExVat) : "",
        lineNet: li.lineNet != null ? String(li.lineNet) : "",
        vatRate: li.vatRate != null ? String(li.vatRate) : "20",
        costPackageId: "",
        trackAsProduct: true,
        productCategory: "",
      })),
    }
  }

  // Read one file → a structured outcome for the queue. Never throws: on
  // failure it returns the internal reason + retry hint so the queue can decide
  // how to pace retries. The original file is retained in Blob storage
  // server-side regardless of outcome.
  async function readOneFile(file: File): Promise<{
    ok: boolean
    result?: Draft[] | null
    documentCount: number
    errorReason?: string | null
    retryable?: boolean
    retryAfterMs?: number | null
    incomplete?: boolean
  }> {
    let result: ExtractionResult
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/extract-invoice", { method: "POST", body: fd })
      result = (await res.json()) as ExtractionResult
    } catch (err) {
      // Network/transport failure talking to our own route — treat as retryable.
      console.log("[v0] upload/extraction request failed:", (err as Error).message)
      return { ok: false, documentCount: 0, errorReason: "gateway", retryable: true }
    }

    if (!result.ok) {
      return {
        ok: false,
        documentCount: 0,
        errorReason: result.errorReason,
        retryable: result.retryable,
        retryAfterMs: result.retryAfterMs,
      }
    }

    const source = { fileName: result.fileName, pathname: result.sourceFilePathname, hash: result.sourceFileHash }
    const drafts = result.documents.map((d) => draftFromDocument(d, source))
    return { ok: true, result: drafts, documentCount: drafts.length, incomplete: result.incomplete }
  }

  // Map a queue snapshot onto the progress UI. Called on every queue update so
  // the reading screen reflects live status, throttling and auto-retry.
  function syncFromQueue(snap: QueueSnapshot<Draft[]>) {
    setFileProgress(
      snap.items.map((it) => ({
        fileName: it.fileName,
        status: it.status,
        documentCount: it.documentCount,
        errorReason: it.errorReason ?? null,
        retryable: it.retryable,
        incomplete: it.incomplete,
        attempts: it.attempts,
      })),
    )
    setProcessedCount(snap.processed)
    setQueuePhase(snap.phase)
    setResumeInMs(snap.resumeInMs)
    setQuotaBlocked(snap.quotaBlocked)
  }

  // Collect successfully-read drafts from the queue in file order. Failed files
  // contribute nothing here; `continueWithFailures` seeds their manual drafts.
  function collectFromQueue(): (Draft[] | null)[] {
    const q = queueRef.current
    if (!q) return []
    return q.snapshot().items.map((it) => (it.status === "done" ? (it.result ?? []) : null))
  }

  // Batch entry point: build the quota-aware queue and drain it. The queue
  // paces requests, pauses globally on rate limits and auto-retries transient
  // failures. When it settles we either go to review or hold on the reading
  // screen so the user can (optionally) retry or continue manually.
  async function handleFiles(files: File[]) {
    if (files.length === 0) return
    setError(null)
    setExtracting(true)
    setStep("reading")
    setReadingDone(false)
    setProcessedCount(0)
    setQuotaBlocked(false)
    setQueuePhase("reading")
    batchFilesRef.current = files
    setFileProgress(files.map((f) => ({ fileName: f.name, status: "pending", documentCount: 0 })))

    const queue = new ExtractionQueue<Draft[]>({
      files: files.map((f, index) => ({ index, fileName: f.name })),
      read: (index) => readOneFile(files[index]),
      onUpdate: syncFromQueue,
      config: QUEUE_CONFIG,
    })
    queueRef.current = queue

    await queue.run()
    setReadingDone(true)

    if (collectFromQueue().some((d) => d === null)) {
      // Hold on the reading screen; the user chooses Retry failed or Continue.
      setExtracting(false)
    } else {
      await finishReading()
    }
  }

  // Manual fallback: re-open the still-failed items in the SAME queue (so all
  // successfully-read documents are preserved and never re-read) and drain
  // again. Not part of the normal flow — the queue already auto-retries.
  async function retryFailed() {
    const queue = queueRef.current
    if (!queue) return
    setRetrying(true)
    setReadingDone(false)
    queue.reopen()
    await queue.run()
    setRetrying(false)
    setReadingDone(true)
    if (!collectFromQueue().some((d) => d === null)) await finishReading()
  }

  // Give up on the remaining failures: seed a blank manual-entry draft for each
  // (retaining today's fallback) and proceed to review with everything else.
  async function continueWithFailures() {
    const files = batchFilesRef.current
    const collected = collectFromQueue().map((d, i) =>
      d === null ? [{ ...blankDraft(), sourceFileName: files[i]?.name ?? null }] : d,
    )
    await finishReading(collected)
  }

  // Flatten collected drafts in file order, then run the full intelligence pass:
  // supplier matching, duplicate classification across ALL documents (including
  // retried files and documents split out of a consolidated PDF), normalisation,
  // AI enrichment, learned-mapping recall and arithmetic validation. Best-effort
  // — never blocks ingestion.
  async function finishReading(collectedByFile?: (Draft[] | null)[]) {
    setExtracting(true)
    const collected: Draft[] = (collectedByFile ?? collectFromQueue()).flatMap((d) => d ?? [])

    setEnriching(true)
    try {
      const intel = await prepareBatch(
        collected.map((d) => ({
          supplierName: d.newSupplierName,
          invoiceNumber: d.invoiceNumber.trim() || null,
          transactionType: d.transactionType,
          invoiceDate: d.invoiceDate || null,
          net: d.net ? parseFloat(d.net) : null,
          vat: d.vat ? parseFloat(d.vat) : null,
          gross: d.gross ? parseFloat(d.gross) : null,
          sourceFileHash: d.sourceFileHash,
          lines: d.lines.map((l) => ({
            description: l.description,
            quantity: l.quantity ? parseFloat(l.quantity) : null,
            unit: l.unit || null,
            unitPriceExVat: l.unitPriceExVat ? parseFloat(l.unitPriceExVat) : null,
            lineNet: l.lineNet ? parseFloat(l.lineNet) : null,
            vatRate: l.vatRate ? parseFloat(l.vatRate) : null,
          })),
        })),
      )
      for (let i = 0; i < collected.length; i++) {
        if (intel[i]) applyIntelligence(collected[i], intel[i])
      }
    } catch (err) {
      console.log("[v0] prepareBatch failed:", (err as Error).message)
      // Non-fatal: proceed without intelligence rather than block ingestion.
    }
    setEnriching(false)

    setExtracting(false)
    setDrafts(collected)
    setSaved(collected.map(() => false))
    // Start on the first document that isn't already imported, if any.
    const firstActionable = collected.findIndex((d) => d.verdict?.status !== "already_imported")
    setCurrent(firstActionable === -1 ? 0 : firstActionable)
    setStep("review")
  }

  // Fold a document's intelligence into its draft in place (mutates the draft,
  // which is safe here because these drafts have not yet been handed to React).
  function applyIntelligence(d: Draft, intel: DocIntelligence) {
    d.verdict = intel.verdict
    d.reconciled = intel.reconciled
    d.reconIssues = intel.reconIssues
    const m = intel.supplierMatch
    // Map the server's confidence grade to a UI status: an exact string match
    // (score 1) is "exact", other high-confidence matches "strong", medium
    // matches are "weak" suggestions, and everything else "none".
    const status: SupplierMatchInfo["status"] =
      m.confidence === "high" ? (m.score >= 1 ? "exact" : "strong") : m.confidence === "medium" ? "weak" : "none"
    d.supplierMatch = {
      supplierId: m.supplierId,
      supplierName: m.supplierName,
      status,
      score: m.score,
    }
    // Auto-select the supplier only on an exact/strong match; a weak match is
    // surfaced as a suggestion the reviewer confirms.
    if (m.supplierId != null && (status === "exact" || status === "strong")) {
      d.supplierId = String(m.supplierId)
    }
    d.lines = d.lines.map((line, i) => {
      const li = intel.lines[i]
      if (!li) return line
      return {
        ...line,
        unit: line.unit || li.rawUnit || "",
        normalisedUnit: li.normalisedUnit,
        unitConfident: li.unitConfident,
        trackAsProduct: li.trackAsProduct,
        trackReason: li.trackReason,
        trackConfidence: li.trackConfidence,
        manufacturer: li.manufacturer,
        productType: li.productType,
        productFamily: li.productFamily,
        dimensions: li.dimensions,
        thickness: li.thickness,
        normalisedName: li.normalisedName,
        subcategory: li.subcategory,
        productCategory: line.productCategory || li.category || "",
        learnedPackageCode: li.learnedPackageCode,
        learnedPackageName: li.learnedPackageName,
        packageFromMemory: li.fromMemory,
      }
    })
  }

  function blankDraft(): Draft {
    return {
      supplierId: "",
      newSupplierName: "",
      projectId: "",
      invoiceNumber: "",
      invoiceDate: "",
      transactionType: "invoice",
      net: "",
      vat: "",
      gross: "",
      notes: "",
      pageStart: null,
      pageEnd: null,
      sourceFileName: null,
      sourceFilePathname: null,
      sourceFileHash: null,
      verdict: null,
      confirmedNew: false,
      supplierMatch: null,
      extractionRaw: null,
      confidence: null,
      reconciled: true,
      reconIssues: [],
      lines: [{ ...emptyLine }],
    }
  }

  async function onProjectChange(projectId: string) {
    if (!draft) return
    const capturedIndex = current
    setDraft({ ...draft, projectId })
    if (!projectId) {
      setPackages([])
      return
    }
    const pkgs = await fetchCostPackages(Number(projectId))
    setPackages(pkgs)
    await resolvePackagesFor(capturedIndex, Number(projectId))
  }

  // Ask the server to resolve a cost package per line for a document within the
  // chosen project (learned mappings first, then AI over the project's plan).
  // Only fills packages the reviewer hasn't already chosen.
  async function resolvePackagesFor(docIndex: number, projectId: number) {
    const d = drafts[docIndex]
    if (!d) return
    setSuggesting(true)
    try {
      const resolved = await suggestPackagesForProject(
        projectId,
        d.lines.map((l) => ({
          description: l.description,
          category: l.productCategory || null,
          productType: l.productType ?? null,
          normalisedName: l.normalisedName ?? l.description,
          learnedPackageCode: l.learnedPackageCode ?? null,
          learnedPackageName: l.learnedPackageName ?? null,
        })),
      )
      setDrafts((prev) =>
        prev.map((doc, i) => {
          if (i !== docIndex) return doc
          return {
            ...doc,
            lines: doc.lines.map((line, li) => {
              const r = resolved[li]
              if (!r || r.packageId == null) return line
              // Preselect both high- and medium-confidence suggestions (the user
              // is reviewing exceptions, not classifying from scratch); leave
              // low/none unassigned so they surface as "needs review". Never
              // override a package the user already chose.
              const autoApply =
                !line.costPackageId &&
                !line.packageConfirmed &&
                (r.confidence === "high" || r.confidence === "medium")
              return {
                ...line,
                suggestedPackageId: String(r.packageId),
                suggestConfidence: r.confidence,
                packageFromMemory: r.fromMemory || line.packageFromMemory,
                costPackageId: autoApply ? String(r.packageId) : line.costPackageId,
              }
            }),
          }
        }),
      )
    } catch (err) {
      console.log("[v0] resolvePackagesFor failed:", (err as Error).message)
    } finally {
      setSuggesting(false)
    }
  }

  // Assign one project to every not-yet-actioned document in the batch, then
  // resolve cost packages for each. This is the common case: a whole delivery
  // of invoices belongs to one project.
  async function assignProjectToBatch(projectId: string) {
    setDrafts((prev) => prev.map((d, i) => (saved[i] ? d : { ...d, projectId })))
    if (projectId && draft) {
      const pkgs = await fetchCostPackages(Number(projectId))
      setPackages(pkgs)
      // Resolve packages for each unactioned doc sequentially.
      for (let i = 0; i < drafts.length; i++) {
        if (!saved[i]) await resolvePackagesFor(i, Number(projectId))
      }
    }
  }

  function updateLine(index: number, patch: Partial<DraftLine>) {
    if (!draft) return
    const lines = draft.lines.map((l, i) => {
      if (i !== index) return l
      const next = { ...l, ...patch }
      // Auto-derive line net from qty × unit price when either changes and the
      // user hasn't explicitly typed a line net in the same edit.
      if (("quantity" in patch || "unitPriceExVat" in patch) && !("lineNet" in patch)) {
        const qty = parseFloat(next.quantity)
        const unit = parseFloat(next.unitPriceExVat)
        if (!Number.isNaN(qty) && !Number.isNaN(unit)) {
          next.lineNet = (qty * unit).toFixed(2)
        }
      }
      return next
    })
    setDraft({ ...draft, lines })
  }

  function recalcTotals(lines: DraftLine[]) {
    let net = 0
    let vat = 0
    for (const l of lines) {
      const n = parseFloat(l.lineNet) || 0
      const rate = parseFloat(l.vatRate) || 0
      net += n
      vat += n * (rate / 100)
    }
    return { net, vat, gross: net + vat }
  }

  function autoFillTotals() {
    if (!draft) return
    const t = recalcTotals(draft.lines)
    setDraft({
      ...draft,
      net: t.net.toFixed(2),
      vat: t.vat.toFixed(2),
      gross: t.gross.toFixed(2),
    })
  }

  // Advance to the next un-actioned document, or show the batch summary once
  // every document has been imported, skipped, or flagged as already imported.
  function advanceOrFinish(doneIndex: number, thisOutcome: BatchOutcome) {
    setOutcomes((prev) => [...prev, thisOutcome])
    const nextSaved = saved.map((s, i) => (i === doneIndex ? true : s))
    setSaved(nextSaved)
    const nextIndex = nextSaved.findIndex(
      (s, i) => !s && drafts[i]?.verdict?.status !== "already_imported",
    )
    if (nextIndex === -1) {
      setStep("summary")
    } else {
      goToDocument(nextIndex)
    }
  }

  function outcomeBase(d: Draft, index: number) {
    return {
      label: documentLabel(d, index),
      supplierName: d.newSupplierName.trim() || "Unknown supplier",
      invoiceNumber: d.invoiceNumber.trim() || null,
      transactionType: d.transactionType,
      net: d.net ? parseFloat(d.net) : 0,
      gross: d.gross ? parseFloat(d.gross) : null,
      priceLines: d.lines.filter((l) => l.description.trim() && l.trackAsProduct && l.unitPriceExVat).length,
    }
  }

  // Skip a document without importing it (used for possible/confirmed duplicates
  // the user decides not to import).
  function skipCurrent() {
    if (!draft) return
    const isDupe = draft.verdict?.status === "already_imported"
    advanceOrFinish(current, {
      ...outcomeBase(draft, current),
      result: isDupe ? "duplicate" : "skipped",
      reason: draft.verdict?.reason ?? null,
      existing: draft.verdict?.existing ?? null,
    })
  }

  function commit() {
    if (!draft) return
    setError(null)
    if (!draft.supplierId && !draft.newSupplierName.trim()) {
      setError("Select or enter a supplier before saving.")
      return
    }
    const pkgById = new Map(packages.map((p) => [String(p.id), p]))
    const payloadLines: CommitLineItem[] = draft.lines
      .filter((l) => l.description.trim())
      .map((l) => {
        const pkg = l.costPackageId ? pkgById.get(l.costPackageId) : undefined
        return {
          description: l.description.trim(),
          quantity: l.quantity ? parseFloat(l.quantity) : null,
          unit: l.unit.trim() || null,
          normalisedUnit: l.normalisedUnit ?? null,
          unitPriceExVat: l.unitPriceExVat ? parseFloat(l.unitPriceExVat) : null,
          lineNet: parseFloat(l.lineNet) || 0,
          vatRate: l.vatRate ? parseFloat(l.vatRate) : null,
          costPackageId: l.costPackageId ? Number(l.costPackageId) : null,
          costPackageCode: pkg?.code ?? l.learnedPackageCode ?? null,
          costPackageName: pkg?.name ?? l.learnedPackageName ?? null,
          productId: null,
          trackAsProduct: l.trackAsProduct,
          isPriceTracked: l.trackAsProduct,
          newProductName: null,
          newProductCategory: l.productCategory.trim() || null,
          normalisedProduct: {
            normalisedName: l.normalisedName ?? null,
            productFamily: l.productFamily ?? null,
            productType: l.productType ?? null,
            dimensions: l.dimensions ?? null,
            thickness: l.thickness ?? null,
            subcategory: l.subcategory ?? null,
          },
        }
      })

    const capturedIndex = current
    const capturedDraft = draft

    startSaving(async () => {
      try {
        const status = docStatus(capturedDraft)
        const result = await commitInvoice({
          supplierId: capturedDraft.supplierId ? Number(capturedDraft.supplierId) : null,
          newSupplierName: capturedDraft.supplierId ? null : capturedDraft.newSupplierName.trim(),
          rawSupplierHeading: capturedDraft.newSupplierName.trim() || null,
          projectId: capturedDraft.projectId ? Number(capturedDraft.projectId) : null,
          invoiceNumber: capturedDraft.invoiceNumber.trim() || null,
          invoiceDate: capturedDraft.invoiceDate || null,
          transactionType: capturedDraft.transactionType,
          net: parseFloat(capturedDraft.net) || 0,
          vat: parseFloat(capturedDraft.vat) || 0,
          gross: parseFloat(capturedDraft.gross) || 0,
          sourceFileName: capturedDraft.sourceFileName,
          sourceFilePathname: capturedDraft.sourceFilePathname,
          sourceFileHash: capturedDraft.sourceFileHash,
          sourcePageStart: capturedDraft.pageStart,
          sourcePageEnd: capturedDraft.pageEnd,
          notes: capturedDraft.notes.trim() || null,
          extractionRaw: capturedDraft.extractionRaw,
          confidence: capturedDraft.confidence,
          reconciled: capturedDraft.reconciled,
          needsReview: !status.ready,
          lineItems: payloadLines,
        })

        const base = outcomeBase(capturedDraft, capturedIndex)

        if (result.status === "duplicate") {
          // The server refused to double-import. Nothing was written; record it
          // as a duplicate and mark the draft so the review UI reflects reality.
          const reason = "Confirmed on save — this document is already in the system."
          setDrafts((prev) =>
            prev.map((d, i) =>
              i === capturedIndex
                ? { ...d, verdict: { status: "already_imported", existing: result.existing, reason } }
                : d,
            ),
          )
          advanceOrFinish(capturedIndex, {
            ...base,
            priceLines: 0,
            result: "duplicate",
            reason,
            existing: result.existing,
          })
        } else {
          advanceOrFinish(capturedIndex, { ...base, result: "imported", reason: null, existing: null })
        }
      } catch (e) {
        setError((e as Error).message || "Something went wrong while saving.")
      }
    })
  }

  function goToDocument(index: number) {
    setError(null)
    setCurrent(index)
    // Keep the cost-package dropdown in sync with the target document's project.
    const target = drafts[index]
    if (target?.projectId) {
      fetchCostPackages(Number(target.projectId))
        .then(setPackages)
        .catch(() => setPackages([]))
    } else {
      setPackages([])
    }
  }

  function resetToUpload() {
    setStep("upload")
    setError(null)
    setPackages([])
    setDrafts([])
    setSaved([])
    setOutcomes([])
    setFileProgress([])
    setCurrent(0)
    setReadingDone(false)
    setRetrying(false)
    setQueuePhase("idle")
    setResumeInMs(0)
    setQuotaBlocked(false)
    batchFilesRef.current = []
    queueRef.current = null
  }

  if (step === "upload") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-10">
        <UploadDropzone onFiles={handleFiles} />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">How this works</h2>
          <ol className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            <li>1. Upload one or more files (PDF or image). Each file can contain several invoices or credit notes.</li>
            <li>2. We keep every original document and read the supplier, totals and line items automatically.</li>
            <li>3. We flag anything that looks like it&apos;s already in the system so nothing is double-counted.</li>
            <li>4. Review each detected document, assign a project and cost packages, then confirm.</li>
          </ol>
        </div>
        <button
          type="button"
          onClick={() => {
            setDrafts([blankDraft()])
            setSaved([false])
            setOutcomes([])
            setCurrent(0)
            setStep("review")
          }}
          className="text-sm font-medium text-primary hover:underline"
        >
          Or enter an invoice manually
        </button>
      </div>
    )
  }

  if (step === "reading") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-10">
        <BatchProgress
          files={fileProgress}
          processed={processedCount}
          done={readingDone}
          retrying={retrying}
          phase={queuePhase}
          resumeInMs={resumeInMs}
          quotaBlocked={quotaBlocked}
          onRetryFailed={retryFailed}
          onContinue={continueWithFailures}
        />
      </div>
    )
  }

  if (step === "summary") {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
        <BatchSummary
          data={buildSummaryData(outcomes, fileProgress)}
          onDone={() => {
            router.push("/invoices")
            router.refresh()
          }}
          onUploadMore={resetToUpload}
        />
      </div>
    )
  }

  if (!draft) return null

  const verdict = draft.verdict
  const isAlreadyImported = verdict?.status === "already_imported"
  const isPossibleDuplicate = verdict?.status === "possible_duplicate"

  // Per-document status for the whole batch, used by the exception overview.
  const statuses = drafts.map((d) => docStatus(d))
  const currentStatus = statuses[current]
  const pending = drafts.map((_, i) => !saved[i])
  const readyCount = statuses.filter((s, i) => pending[i] && s.ready).length
  const attentionCount = statuses.filter((s, i) => pending[i] && !s.ready).length
  const jumpToFirstAttention = () => {
    const idx = statuses.findIndex((s, i) => pending[i] && !s.ready)
    if (idx !== -1) goToDocument(idx)
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {draft.sourceFileName ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="h-4 w-4" strokeWidth={1.75} />
          {draft.sourceFileName}
          {draft.pageStart ? (
            <span className="text-xs">
              · {draft.pageStart === draft.pageEnd ? `page ${draft.pageStart}` : `pages ${draft.pageStart}–${draft.pageEnd}`}
            </span>
          ) : null}
        </div>
      ) : null}

      {total > 1 ? (
        <div className="flex flex-col gap-3.5 rounded-xl border border-border bg-card px-4 py-4">
          {/* Summary line + batch-wide project assignment */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold text-foreground">{total} documents</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{savedCount} actioned</span>
              {enriching || suggesting ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                  Analysing…
                </span>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              Assign all to
              <select
                value=""
                onChange={(e) => e.target.value && assignProjectToBatch(e.target.value)}
                className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground focus:border-ring focus:outline-none"
              >
                <option value="">Choose project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Exception counts + jump */}
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone="success">{readyCount} ready</StatusPill>
            <StatusPill tone="warning">{attentionCount} need attention</StatusPill>
            {attentionCount > 0 ? (
              <button
                type="button"
                onClick={jumpToFirstAttention}
                className="text-xs font-medium text-primary hover:underline"
              >
                Go to next exception
              </button>
            ) : null}
            <div className="ml-auto flex items-center gap-1 rounded-lg border border-border p-0.5">
              {(["all", "attention", "ready"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                    filter === f
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Document chips (filtered) */}
          <div className="flex flex-wrap gap-2">
            {drafts.map((d, i) => {
              const st = statuses[i]
              const isSaved = saved[i]
              if (filter === "attention" && (isSaved || st.ready)) return null
              if (filter === "ready" && (isSaved || !st.ready)) return null
              const isCurrent = i === current
              const tone = isSaved
                ? "border-success/40 bg-success-bg text-success"
                : st.severity === "block"
                  ? "border-danger/40 bg-danger-bg text-danger"
                  : st.severity === "warn"
                    ? "border-warning/40 bg-warning-bg text-warning"
                    : "border-border bg-card text-foreground hover:bg-muted"
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => goToDocument(i)}
                  title={st.reasons.join(" · ") || "Ready"}
                  className={cn(
                    "flex max-w-[16rem] items-center gap-1.5 truncate rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                    isCurrent ? "ring-2 ring-ring ring-offset-1 ring-offset-card" : "",
                    tone,
                  )}
                >
                  {isSaved ? (
                    <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
                  ) : (
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        st.ready ? "bg-success" : st.severity === "block" ? "bg-danger" : "bg-warning",
                      )}
                    />
                  )}
                  <span className="truncate">{documentLabel(d, i)}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {/* Per-document status banner */}
      {!saved[current] && currentStatus ? (
        currentStatus.ready ? (
          <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-bg px-4 py-2.5 text-sm text-success">
            <Check className="h-4 w-4" strokeWidth={2.5} />
            Ready to import — everything looks confident.
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-warning/30 bg-warning-bg px-4 py-2.5 text-sm text-warning">
            <span className="font-medium">Needs attention:</span>
            {currentStatus.reasons.map((r, i) => (
              <span key={i} className="rounded bg-warning/15 px-1.5 py-0.5 text-xs">
                {r}
              </span>
            ))}
          </div>
        )
      ) : null}

      {verdict && verdict.status !== "new" && !saved[current] ? (
        <DuplicateNotice
          verdict={verdict}
          confirmedNew={draft.confirmedNew}
          onConfirmChange={(v) => setDraft({ ...draft, confirmedNew: v })}
        />
      ) : null}

      {saved[current] ? (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-bg px-4 py-3 text-sm text-success">
          <Check className="h-4 w-4" strokeWidth={2.5} />
          This document has been actioned.
        </div>
      ) : null}

      {/* Header details */}
      <section className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-2">
        <Field label="Supplier">
          {suppliers.length > 0 ? (
            <select
              value={draft.supplierId}
              onChange={(e) => setDraft({ ...draft, supplierId: e.target.value })}
              className={selectCls}
            >
              <option value="">+ New supplier…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null}
          {!draft.supplierId ? (
            <input
              value={draft.newSupplierName}
              onChange={(e) => setDraft({ ...draft, newSupplierName: e.target.value })}
              placeholder="Supplier name"
              className={cn(inputCls, suppliers.length > 0 && "mt-2")}
            />
          ) : null}
          {/* Fuzzy match suggestion when we didn't auto-select a supplier. */}
          {!draft.supplierId &&
          draft.supplierMatch &&
          draft.supplierMatch.supplierId != null &&
          draft.supplierMatch.status !== "none" ? (
            <button
              type="button"
              onClick={() =>
                setDraft({ ...draft, supplierId: String(draft.supplierMatch!.supplierId) })
              }
              className="mt-2 flex items-center gap-1.5 text-left text-xs font-medium text-primary hover:underline"
            >
              Use existing supplier &ldquo;{draft.supplierMatch.supplierName}&rdquo;?
            </button>
          ) : null}
          {draft.supplierId &&
          draft.supplierMatch &&
          (draft.supplierMatch.status === "exact" || draft.supplierMatch.status === "strong") ? (
            <span className="mt-1.5 text-xs text-muted-foreground">Matched an existing supplier.</span>
          ) : null}
        </Field>

        <Field label="Project">
          <select value={draft.projectId} onChange={(e) => onProjectChange(e.target.value)} className={selectCls}>
            <option value="">Unassigned</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Document type">
          <select
            value={draft.transactionType}
            onChange={(e) =>
              setDraft({ ...draft, transactionType: e.target.value as "invoice" | "credit" })
            }
            className={selectCls}
          >
            <option value="invoice">Invoice</option>
            <option value="credit">Credit note</option>
          </select>
        </Field>

        <Field label="Invoice number">
          <input
            value={draft.invoiceNumber}
            onChange={(e) => setDraft({ ...draft, invoiceNumber: e.target.value })}
            className={inputCls}
          />
        </Field>

        <Field label="Invoice date">
          <input
            type="date"
            value={draft.invoiceDate}
            onChange={(e) => setDraft({ ...draft, invoiceDate: e.target.value })}
            className={inputCls}
          />
        </Field>
      </section>

      {/* Line items */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Line items</h2>
          <button
            type="button"
            onClick={autoFillTotals}
            className="text-xs font-medium text-primary hover:underline"
          >
            Recalculate totals from lines
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {draft.lines.map((line, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <input
                  value={line.description}
                  onChange={(e) => updateLine(i, { description: e.target.value })}
                  placeholder="Description"
                  className={cn(inputCls, "flex-1")}
                />
                <button
                  type="button"
                  onClick={() =>
                    setDraft({ ...draft, lines: draft.lines.filter((_, idx) => idx !== i) })
                  }
                  aria-label="Remove line"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </div>

              {/* What the intelligence pass understood about this line. */}
              {line.manufacturer || line.productType || line.dimensions || line.packageFromMemory ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {line.packageFromMemory ? (
                    <span className="rounded-full border border-info/40 bg-info-bg px-2 py-0.5 text-[11px] font-medium text-info">
                      Remembered
                    </span>
                  ) : null}
                  {line.manufacturer ? <LineTag>{line.manufacturer}</LineTag> : null}
                  {line.productType ? <LineTag>{line.productType}</LineTag> : null}
                  {line.dimensions ? <LineTag>{line.dimensions}</LineTag> : null}
                  {line.normalisedUnit && line.normalisedUnit !== line.unit ? (
                    <LineTag>unit → {line.normalisedUnit}</LineTag>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniField label="Qty">
                  <input
                    value={line.quantity}
                    onChange={(e) => updateLine(i, { quantity: e.target.value })}
                    inputMode="decimal"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Unit">
                  <input
                    value={line.unit}
                    onChange={(e) => updateLine(i, { unit: e.target.value })}
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Unit price (ex VAT)">
                  <input
                    value={line.unitPriceExVat}
                    onChange={(e) => updateLine(i, { unitPriceExVat: e.target.value })}
                    inputMode="decimal"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Line net">
                  <input
                    value={line.lineNet}
                    onChange={(e) => updateLine(i, { lineNet: e.target.value })}
                    inputMode="decimal"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="VAT %">
                  <input
                    value={line.vatRate}
                    onChange={(e) => updateLine(i, { vatRate: e.target.value })}
                    inputMode="decimal"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Cost package">
                  <select
                    value={line.costPackageId}
                    onChange={(e) => updateLine(i, { costPackageId: e.target.value, packageConfirmed: true })}
                    disabled={packages.length === 0}
                    className={selectCls}
                  >
                    <option value="">
                      {packages.length === 0 ? "Select a project first" : "Unassigned"}
                    </option>
                    {packages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code ? `${p.code} · ` : ""}
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <CostPackageHint
                    line={line}
                    hasPackages={packages.length > 0}
                    onConfirm={() => updateLine(i, { packageConfirmed: true })}
                    onAccept={() =>
                      line.suggestedPackageId &&
                      updateLine(i, { costPackageId: line.suggestedPackageId, packageConfirmed: true })
                    }
                  />
                </MiniField>
                <MiniField label="Category">
                  <input
                    value={line.productCategory}
                    onChange={(e) => updateLine(i, { productCategory: e.target.value })}
                    placeholder="e.g. Timber"
                    className={inputCls}
                  />
                </MiniField>
                <MiniField label="Track price">
                  <label className="flex h-11 items-center gap-2 sm:h-9">
                    <input
                      type="checkbox"
                      checked={line.trackAsProduct}
                      onChange={(e) => updateLine(i, { trackAsProduct: e.target.checked })}
                      className="h-4 w-4 rounded border-border"
                    />
                    <span className="text-sm text-muted-foreground">Add to price DB</span>
                  </label>
                  {line.trackReason ? (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {line.trackReason}
                    </span>
                  ) : null}
                </MiniField>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setDraft({ ...draft, lines: [...draft.lines, { ...emptyLine }] })}
          className="flex w-fit items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          Add line
        </button>
      </section>

      {/* Totals */}
      <section className="grid grid-cols-3 gap-4 rounded-lg border border-border bg-card p-5">
        <MiniField label="Net">
          <input
            value={draft.net}
            onChange={(e) => setDraft({ ...draft, net: e.target.value })}
            inputMode="decimal"
            className={inputCls}
          />
        </MiniField>
        <MiniField label="VAT">
          <input
            value={draft.vat}
            onChange={(e) => setDraft({ ...draft, vat: e.target.value })}
            inputMode="decimal"
            className={inputCls}
          />
        </MiniField>
        <MiniField label="Gross">
          <input
            value={draft.gross}
            onChange={(e) => setDraft({ ...draft, gross: e.target.value })}
            inputMode="decimal"
            className={inputCls}
          />
        </MiniField>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {draft.gross ? `Total ${formatGBP(parseFloat(draft.gross) || 0, { decimals: true })}` : ""}
        </span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => (total > 1 ? setStep("summary") : router.push("/invoices"))}
            className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            Cancel
          </button>
          {!saved[current] ? (
            <button
              type="button"
              onClick={skipCurrent}
              disabled={saving}
              className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
            >
              {isAlreadyImported ? "Skip (already imported)" : "Skip this document"}
            </button>
          ) : null}
          {/* Already-imported documents can only be skipped — never re-imported
              from the batch flow — so we hide the import action entirely. */}
          {isAlreadyImported && !saved[current] ? null : (
          <button
            type="button"
            onClick={commit}
            disabled={saving || (isPossibleDuplicate && !draft.confirmedNew)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-60",
              isPossibleDuplicate
                ? "bg-warning text-warning-foreground hover:opacity-90"
                : "bg-primary text-primary-foreground hover:opacity-90",
            )}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : null}
            {saved[current]
              ? "Save again"
              : isPossibleDuplicate
                ? "Import anyway"
                : savedCount + 1 < total
                  ? "Save & next document"
                  : total > 1
                    ? "Save last document"
                    : "Confirm & save"}
            {!saving && !saved[current] && !isPossibleDuplicate && savedCount + 1 < total ? (
              <ChevronRight className="h-4 w-4" strokeWidth={2} />
            ) : null}
          </button>
          )}
        </div>
      </div>
    </div>
  )
}

function UploadDropzone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false)
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const files = Array.from(e.dataTransfer.files ?? [])
        if (files.length) onFiles(files)
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border-strong bg-card hover:bg-muted/40",
      )}
    >
      <input
        type="file"
        accept="application/pdf,image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) onFiles(files)
          e.target.value = ""
        }}
      />
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Upload className="h-6 w-6" strokeWidth={1.75} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-foreground">
          Drop invoices here or tap to browse
        </span>
        <span className="text-xs text-muted-foreground">
          One or more PDFs or images · each file may contain several documents
        </span>
      </div>
    </label>
  )
}

const inputCls =
  "h-11 w-full rounded-lg border border-border bg-background px-3 text-base text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30 sm:h-9 sm:text-sm"
const selectCls = inputCls

function documentLabel(d: Draft, index: number): string {
  const num = d.invoiceNumber?.trim()
  const sup = d.newSupplierName?.trim()
  if (num && sup) return `${sup} · ${num}`
  return num || sup || `Document ${index + 1}`
}

export type DocStatus = {
  /** true when nothing about this document needs a human decision. */
  ready: boolean
  /** short, human reasons the document needs attention (empty when ready). */
  reasons: string[]
  /** the most severe reason class, for colour-coding. */
  severity: "ok" | "warn" | "block"
}

// Review-by-exception core: decide whether a document can be waved through or
// needs a human. Everything genuinely ambiguous or risky surfaces here so a
// reviewer can ignore the confident majority and only touch the exceptions.
function docStatus(d: Draft): DocStatus {
  const reasons: string[] = []
  let severity: "ok" | "warn" | "block" = "ok"
  const bump = (s: "warn" | "block") => {
    if (s === "block" || severity === "ok") severity = s
  }

  const v = d.verdict?.status
  if (v === "already_imported") {
    reasons.push("Looks already imported")
    bump("block")
  } else if (v === "possible_duplicate" && !d.confirmedNew) {
    reasons.push("Possible duplicate — confirm to import")
    bump("block")
  }

  const hasSupplier = Boolean(d.supplierId || d.newSupplierName.trim())
  if (!hasSupplier) {
    reasons.push("No supplier")
    bump("block")
  } else if (!d.supplierId && d.supplierMatch && d.supplierMatch.status === "weak") {
    reasons.push("Confirm supplier match")
    bump("warn")
  }

  if (!d.invoiceNumber.trim()) {
    reasons.push("No document number")
    bump("warn")
  }
  if (!d.invoiceDate) {
    reasons.push("No date")
    bump("warn")
  }
  if (!d.gross || parseFloat(d.gross) === 0) {
    reasons.push("No total")
    bump("warn")
  }
  if (!d.reconciled) {
    reasons.push("Totals don't reconcile")
    bump("warn")
  }
  if (d.confidence === "low") {
    reasons.push("Low extraction confidence")
    bump("warn")
  }
  if (d.lines.length === 0 || d.lines.every((l) => !l.description.trim())) {
    reasons.push("No line items")
    bump("warn")
  }

  // Cost-package classification is an important field: once a project is chosen
  // every genuine line should land in a package. Flag lines left unassigned, or
  // where only a medium-confidence guess was preselected and not yet confirmed.
  if (d.projectId) {
    const genuine = d.lines.filter((l) => l.description.trim())
    const unassigned = genuine.filter((l) => !l.costPackageId).length
    const unconfirmed = genuine.filter(
      (l) => l.costPackageId && l.suggestConfidence === "medium" && !l.packageConfirmed,
    ).length
    if (unassigned > 0) {
      reasons.push(unassigned === 1 ? "1 line needs a cost package" : `${unassigned} lines need a cost package`)
      bump("warn")
    }
    if (unconfirmed > 0) {
      reasons.push(
        unconfirmed === 1 ? "Confirm 1 cost-package suggestion" : `Confirm ${unconfirmed} cost-package suggestions`,
      )
      bump("warn")
    }
  }

  return { ready: reasons.length === 0, reasons, severity }
}

function buildSummaryData(outcomes: BatchOutcome[], files: FileProgress[]): BatchSummaryData {
  const suppliers = new Set<string>()
  let invoicesAdded = 0
  let creditsAdded = 0
  let duplicatesSkipped = 0
  let otherSkipped = 0
  let totalNetAdded = 0
  let priceRecordsCreated = 0
  const needingAttention: { label: string; reason: string }[] = []

  for (const o of outcomes) {
    if (o.result === "imported") {
      if (o.transactionType === "credit") creditsAdded++
      else invoicesAdded++
      totalNetAdded += o.net
      priceRecordsCreated += o.priceLines
      suppliers.add(o.supplierName)
    } else if (o.result === "duplicate") {
      duplicatesSkipped++
      needingAttention.push({
        label: o.label,
        reason: o.reason ?? "Already imported — not counted again.",
      })
    } else if (o.result === "skipped") {
      otherSkipped++
    }
  }

  return {
    sourceFileCount: files.length,
    documentsDetected: outcomes.length,
    invoicesAdded,
    creditsAdded,
    duplicatesSkipped,
    otherSkipped,
    failed: files.filter((f) => f.status === "failed").length,
    totalNetAdded,
    suppliersAffected: [...suppliers],
    priceRecordsCreated,
    needingAttention,
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function MiniField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  )
}

function LineTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {children}
    </span>
  )
}

// Subtle per-line cost-package indicator. Keeps the grid clean: a confident
// suggestion is a quiet muted note, a medium suggestion asks for a one-click
// confirm, and an unresolved package is clearly flagged for review.
function CostPackageHint({
  line,
  hasPackages,
  onConfirm,
  onAccept,
}: {
  line: DraftLine
  hasPackages: boolean
  onConfirm: () => void
  onAccept: () => void
}) {
  if (!hasPackages) return null

  if (line.costPackageId) {
    if (line.packageConfirmed) return null
    if (line.suggestConfidence === "medium") {
      return (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-warning">
            {line.packageFromMemory ? "Remembered · confirm" : "Suggested · confirm"}
          </span>
          <button
            type="button"
            onClick={onConfirm}
            className="text-[11px] font-medium text-primary hover:underline"
          >
            Looks right
          </button>
        </div>
      )
    }
    if (line.suggestConfidence === "high" || line.packageFromMemory) {
      return (
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {line.packageFromMemory ? "Remembered · high confidence" : "Suggested · high confidence"}
        </span>
      )
    }
    return null
  }

  // Unassigned — flag for review, offering the best guess if we have one.
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-medium text-warning">Cost package needs review</span>
      {line.suggestedPackageId ? (
        <button
          type="button"
          onClick={onAccept}
          className="text-[11px] font-medium text-primary hover:underline"
        >
          Use best guess
        </button>
      ) : null}
    </div>
  )
}

function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "info"
  children: React.ReactNode
}) {
  const cls =
    tone === "success"
      ? "border-success/40 bg-success-bg text-success"
      : tone === "warning"
        ? "border-warning/40 bg-warning-bg text-warning"
        : "border-info/40 bg-info-bg text-info"
  return (
    <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", cls)}>
      {children}
    </span>
  )
}
