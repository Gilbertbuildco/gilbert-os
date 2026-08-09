/**
 * Process-wide governor that paces outbound AI-model calls so we never burst
 * past the provider's rate/quota limit. It is a module singleton, so every
 * model call in the same server instance — including the many chunk calls a
 * single large-PDF extraction makes — shares one pacing state.
 *
 * Two mechanisms:
 *  1. Minimum spacing + single-flight: at most one call runs at a time, and
 *     consecutive calls are spaced by at least `minIntervalMs`. This smooths
 *     bursts into a steady, quota-friendly drip.
 *  2. Global pause: when a call is rate-limited, `penalise()` pushes a shared
 *     "resume at" timestamp forward. Every subsequent call waits for it before
 *     starting, so one 429 throttles the whole instance rather than letting the
 *     next call immediately trip the limit again.
 *
 * The authoritative, cross-request quota handling still lives in the client
 * queue (it spans separate HTTP requests); this governor guarantees that even
 * within one request a chunked extraction cannot self-inflict a burst.
 */

export interface GovernorConfig {
  /** Minimum time between the START of consecutive calls. */
  minIntervalMs: number
  /** Hard ceiling for a single pause imposed by one penalty. */
  maxPauseMs: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class RateGovernor {
  private chain: Promise<void> = Promise.resolve()
  private nextAllowedAt = 0
  private resumeAt = 0

  constructor(private cfg: GovernorConfig) {}

  /** Currently-imposed pause remaining, in ms (0 if none). */
  get pauseRemainingMs(): number {
    return Math.max(0, this.resumeAt - Date.now())
  }

  /**
   * Record that a call was rate-limited. Pushes the shared resume time forward
   * by `delayMs` (clamped), so the whole instance backs off together.
   */
  penalise(delayMs: number) {
    const clamped = Math.min(Math.max(0, delayMs), this.cfg.maxPauseMs)
    this.resumeAt = Math.max(this.resumeAt, Date.now() + clamped)
  }

  /**
   * Run `fn` under the governor: single-flight, min-spaced, and after any active
   * pause. Serialises via an internal promise chain so callers need no locking.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const gate = this.chain.then(() => this.waitForSlot())
    // Advance the chain regardless of this call's outcome.
    this.chain = gate.catch(() => {})
    await gate
    return fn()
  }

  private async waitForSlot() {
    // Respect any global pause first, then the minimum spacing.
    for (;;) {
      const now = Date.now()
      const wait = Math.max(this.resumeAt - now, this.nextAllowedAt - now)
      if (wait <= 0) break
      await sleep(wait)
    }
    this.nextAllowedAt = Date.now() + this.cfg.minIntervalMs
  }
}

// Default pacing: one model call at a time, spaced ~1.2s, with pauses capped at
// 60s. Conservative by design — we prefer slow-and-reliable over fast bursts.
export const extractionGovernor = new RateGovernor({ minIntervalMs: 1200, maxPauseMs: 60_000 })
