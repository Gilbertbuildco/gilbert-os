/**
 * Bounded-concurrency worker pool. Runs `task(index)` for every index in
 * [0, count) with at most `concurrency` in flight at once. Each worker pulls
 * the next index until the queue drains.
 *
 * A worker never rejects: any error thrown by `task` is swallowed here so that
 * one unit of work failing can NEVER abort the others. Tasks are therefore
 * expected to capture their own success/failure (e.g. into external state).
 */
export async function runPool(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  if (count <= 0) return
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), count) }, async () => {
    while (cursor < count) {
      const i = cursor++
      try {
        await task(i)
      } catch {
        // Defensive only — task is expected to handle its own errors.
      }
    }
  })
  await Promise.all(workers)
}
