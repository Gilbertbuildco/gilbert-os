"use client"

import { Loader2, FileText, Check, AlertTriangle, RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"

export interface FileProgress {
  fileName: string
  status: "pending" | "reading" | "done" | "failed"
  documentCount: number
  /** Structured, internal reason a file failed (logged; surfaced subtly). */
  errorReason?: string | null
  /** Whether an automatic/user retry could plausibly succeed. */
  retryable?: boolean
  /** True when a large PDF was only partially read within the time budget. */
  incomplete?: boolean
}

interface Props {
  files: FileProgress[]
  processed: number
  /** True once the whole pass has finished (enables the failure actions). */
  done?: boolean
  /** True while a retry pass is running. */
  retrying?: boolean
  onRetryFailed?: () => void
  onContinue?: () => void
}

// Human-readable label for an internal error reason. Kept short; the full
// reason is always logged server-side.
function reasonLabel(reason?: string | null): string {
  switch (reason) {
    case "rate_limit":
      return "Rate-limited — can retry"
    case "timeout":
      return "Timed out — can retry"
    case "too_large":
      return "Too large to read in one pass"
    case "gateway":
      return "Service error — can retry"
    case "no_document":
      return "No invoice found"
    case "invalid_response":
      return "Unreadable response — can retry"
    case "empty_file":
      return "Empty file"
    default:
      return "Couldn't read"
  }
}

export function BatchProgress({ files, processed, done, retrying, onRetryFailed, onContinue }: Props) {
  const total = files.length
  const detected = files.reduce((sum, f) => sum + f.documentCount, 0)
  const failedFiles = files.filter((f) => f.status === "failed")
  const failed = failedFiles.length
  const retryableCount = failedFiles.filter((f) => f.retryable !== false).length

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-10">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {done && !retrying ? (
            <Check className="h-4 w-4 text-success" strokeWidth={2.5} />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          )}
          {retrying
            ? "Retrying failed files…"
            : done
              ? `Read ${total} ${total === 1 ? "file" : "files"}`
              : `Reading ${total} ${total === 1 ? "file" : "files"}…`}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${total ? (processed / total) * 100 : 0}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>
            {processed} of {total} processed
          </span>
          <span>{detected} financial documents detected</span>
          {failed > 0 ? <span className="text-danger">{failed} failed</span> : null}
        </div>
      </div>

      <ul className="flex flex-col gap-1.5">
        {files.map((f, i) => (
          <li
            key={i}
            className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-sm"
          >
            <FileIcon status={f.status} />
            <span className="min-w-0 flex-1 truncate text-foreground">{f.fileName}</span>
            <span
              className={cn(
                "text-xs font-medium",
                f.status === "failed" ? "text-danger" : "text-muted-foreground",
              )}
            >
              {f.status === "reading"
                ? "Reading…"
                : f.status === "failed"
                  ? reasonLabel(f.errorReason)
                  : f.status === "done"
                    ? `${f.documentCount} ${f.documentCount === 1 ? "document" : "documents"}${
                        f.incomplete ? " · partial" : ""
                      }`
                    : "Waiting"}
            </span>
          </li>
        ))}
      </ul>

      {done && failed > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 px-4 py-4">
          <p className="text-sm text-foreground">
            {failed} {failed === 1 ? "file" : "files"} couldn&apos;t be read.{" "}
            {retryableCount > 0
              ? "Most failures are transient — retry them without re-uploading."
              : "You can continue and enter these manually."}
          </p>
          <div className="flex flex-wrap gap-2">
            {retryableCount > 0 && onRetryFailed ? (
              <button
                type="button"
                onClick={onRetryFailed}
                disabled={retrying}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                <RotateCcw className={cn("h-4 w-4", retrying && "animate-spin")} strokeWidth={2} />
                {retrying ? "Retrying…" : `Retry ${retryableCount} failed`}
              </button>
            ) : null}
            {onContinue ? (
              <button
                type="button"
                onClick={onContinue}
                disabled={retrying}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
              >
                Continue to review
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function FileIcon({ status }: { status: FileProgress["status"] }) {
  if (status === "reading")
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" strokeWidth={2} />
  if (status === "done") return <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={2.5} />
  if (status === "failed")
    return <AlertTriangle className="h-4 w-4 shrink-0 text-danger" strokeWidth={2} />
  return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
}
