"use client"

import { Loader2, FileText, Check, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"

export interface FileProgress {
  fileName: string
  status: "pending" | "reading" | "done" | "failed"
  documentCount: number
}

interface Props {
  files: FileProgress[]
  processed: number
}

export function BatchProgress({ files, processed }: Props) {
  const total = files.length
  const detected = files.reduce((sum, f) => sum + f.documentCount, 0)
  const failed = files.filter((f) => f.status === "failed").length

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-10">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          Reading {total} {total === 1 ? "file" : "files"}…
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
                  ? "Couldn't read"
                  : f.status === "done"
                    ? `${f.documentCount} ${f.documentCount === 1 ? "document" : "documents"}`
                    : "Waiting"}
            </span>
          </li>
        ))}
      </ul>
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
