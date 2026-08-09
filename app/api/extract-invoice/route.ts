import { type NextRequest, NextResponse } from "next/server"
import { extractDocumentsFromFile } from "@/lib/invoice-extraction"

// Reading a large multi-page PDF chunk-by-chunk with backoff can take a while.
// This must comfortably exceed the library's per-file deadline; platforms clamp
// it to their own maximum where lower.
export const maxDuration = 300

export async function POST(request: NextRequest) {
  let fileName = "Unknown file"
  try {
    const formData = await request.formData()
    const file = formData.get("file")
    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "No file was provided.", errorReason: "empty_file", retryable: false, fileName },
        { status: 400 },
      )
    }
    fileName = file.name
    const result = await extractDocumentsFromFile(file)
    if (!result.ok) {
      console.log(`[v0] extract-invoice: file="${result.fileName}" failed reason=${result.errorReason}`)
    } else if (result.incomplete) {
      console.log(
        `[v0] extract-invoice: file="${result.fileName}" incomplete — read up to page ${result.truncatedAtPage} of ${result.pageCount}`,
      )
    }
    return NextResponse.json(result)
  } catch (err) {
    // Only reached for unexpected framework-level errors — the library itself
    // returns a structured { ok: false } instead of throwing.
    console.log("[v0] extract-invoice route failed:", (err as Error).message)
    return NextResponse.json(
      {
        ok: false,
        error: "Could not read that document automatically. You can retry it, or enter the details manually below.",
        errorReason: "unknown",
        retryable: true,
        fileName,
        sourceFilePathname: null,
        sourceFileHash: null,
      },
      { status: 200 },
    )
  }
}
