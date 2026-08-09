import { type NextRequest, NextResponse } from "next/server"
import { extractDocumentsFromFile } from "@/lib/invoice-extraction"

// Reading a multi-page PDF with a vision model can take a while.
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get("file")
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "No file was provided." }, { status: 400 })
    }
    const result = await extractDocumentsFromFile(file)
    return NextResponse.json(result)
  } catch (err) {
    console.log("[v0] extract-invoice route failed:", (err as Error).message)
    return NextResponse.json(
      { ok: false, error: "Could not read that document automatically. You can still enter the details manually below." },
      { status: 200 },
    )
  }
}
