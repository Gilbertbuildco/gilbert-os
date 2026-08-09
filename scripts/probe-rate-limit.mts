import { generateObject } from "ai"
import { z } from "zod"

// Fire N tiny requests as fast as possible and record where 429s begin, the
// error shape, and any retry-after metadata. Text-only + tiny schema isolates
// the request-per-minute (RPM) limit from the token-per-minute (TPM) limit.
const MODEL = process.argv[2] ?? "google/gemini-2.5-flash"
const N = parseInt(process.argv[3] ?? "25", 10)
const schema = z.object({ n: z.number().describe("the number 1") })

type Row = { i: number; ms: number; ok: boolean; err?: string }
const rows: Row[] = []
const t0 = Date.now()

await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const start = Date.now()
    try {
      await generateObject({ model: MODEL, schema, prompt: "Return the number 1.", maxRetries: 0 })
      rows.push({ i, ms: Date.now() - start, ok: true })
    } catch (err) {
      rows.push({ i, ms: Date.now() - start, ok: false, err: (err as Error).message?.slice(0, 300) })
    }
  }),
)

rows.sort((a, b) => a.i - b.i)
const ok = rows.filter((r) => r.ok).length
const failed = rows.filter((r) => !r.ok)
console.log(`\nMODEL=${MODEL}  fired=${N}  wallclock=${Date.now() - t0}ms`)
console.log(`OK=${ok}  FAILED=${failed.length}`)
const firstFail = rows.find((r) => !r.ok)
if (firstFail) console.log(`first failure at request index=${firstFail.i}`)
// Print the distinct error messages (dedup) to see 429 shape + retry metadata.
const seen = new Set<string>()
for (const f of failed) {
  const key = f.err ?? ""
  if (seen.has(key)) continue
  seen.add(key)
  console.log(`\n--- distinct error ---\n${f.err}`)
}
