import { generateObject } from "ai"
import { z } from "zod"

// Fire ONE request every `intervalMs` for `n` requests, sequentially, to measure
// the sustainable free-tier rate (and whether spacing avoids rejection at all).
const MODEL = process.argv[2] ?? "google/gemini-2.5-flash"
const N = parseInt(process.argv[3] ?? "8", 10)
const INTERVAL = parseInt(process.argv[4] ?? "5000", 10)
const schema = z.object({ n: z.number() })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log(`MODEL=${MODEL} n=${N} interval=${INTERVAL}ms`)
let ok = 0
for (let i = 0; i < N; i++) {
  const start = Date.now()
  try {
    await generateObject({ model: MODEL, schema, prompt: "Return the number 1.", maxRetries: 0 })
    ok++
    console.log(`#${i} OK (${Date.now() - start}ms)`)
  } catch (err) {
    console.log(`#${i} FAIL (${Date.now() - start}ms): ${(err as Error).message?.slice(0, 120)}`)
  }
  if (i < N - 1) await sleep(INTERVAL)
}
console.log(`\nsustained OK=${ok}/${N} at 1 per ${INTERVAL}ms`)
