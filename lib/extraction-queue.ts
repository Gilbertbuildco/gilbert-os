/**
 * Quota-aware ingestion queue.
 *
 * Each file is read by a SEPARATE HTTP request to the extraction route, so the
 * only place that can see the whole batch — and therefore the only place that
 * can bound the aggregate request rate — is here on the client. This controller
 * is the single authority for pacing:
 *
 *  - CONCURRENCY defaults to 1: at most one extraction request is ever in
 *    flight, so we never fan out N simultaneous model calls (the exact mistake
 *    that tripped the provider limit before). It is configurable for when paid
 *    quota allows more, but stays conservative by default.
 *  - MINIMUM SPACING between request starts smooths a burst into a steady drip.
 *  - GLOBAL PAUSE: a rate-limit/quota response pauses the ENTIRE queue (honouring
 *    retry-after when provided, else escalating backoff), then it resumes
 *    automatically. One document being throttled therefore never fails the
 *    others — they simply wait behind the same pause.
 *  - AUTO-RETRY: transient failures are re-queued with per-item exponential
 *    backoff + jitter up to a cap; the user does not press Retry in the normal
 *    flow. Permanent/document-specific errors are not retried.
 *  - SUCCESS IS STICKY: a file that has been read is never read again.
 *
 * The controller is framework-agnostic and clock-injectable so it can be unit
 * tested deterministically.
 */

export type QueueItemStatus = "pending" | "reading" | "waiting" | "done" | "failed"

export interface QueueItemState<TResult = unknown> {
  index: number
  fileName: string
  status: QueueItemStatus
  attempts: number
  documentCount: number
  errorReason?: string | null
  retryable?: boolean
  incomplete?: boolean
  /** The successful read payload (drafts), when done. */
  result?: TResult | null
}

export type QueuePhase = "idle" | "reading" | "waiting_capacity" | "rate_limited" | "retrying" | "done"

export interface QueueSnapshot<TResult = unknown> {
  items: QueueItemState<TResult>[]
  phase: QueuePhase
  /** done + permanently-failed count (drives the progress bar). */
  processed: number
  /** ms remaining on the current global pause (for a countdown). */
  resumeInMs: number
  /** True when we stopped auto-retrying because the free-tier gate persists. */
  quotaBlocked: boolean
}

export interface ReadOutcome<TResult = unknown> {
  ok: boolean
  result?: TResult | null
  documentCount: number
  errorReason?: string | null
  retryable?: boolean
  retryAfterMs?: number | null
  incomplete?: boolean
}

export interface QueueConfig {
  concurrency: number
  minSpacingMs: number
  maxAttemptsPerItem: number
  baseBackoffMs: number
  maxBackoffMs: number
  /** After this many consecutive quota pauses with no success, stop and surface guidance. */
  maxConsecutiveQuotaPauses: number
  /** Pause length used for a quota/rate failure that gives no retry-after. */
  defaultQuotaPauseMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  concurrency: 1,
  minSpacingMs: 1500,
  maxAttemptsPerItem: 6,
  baseBackoffMs: 2000,
  maxBackoffMs: 60_000,
  maxConsecutiveQuotaPauses: 6,
  defaultQuotaPauseMs: 30_000,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
}

const RETRYABLE_TRANSIENT = new Set(["timeout", "gateway", "invalid_response", "unknown", "rate_limit"])
const QUOTA_REASONS = new Set(["quota_exceeded", "rate_limit"])

interface InternalItem<TResult> extends QueueItemState<TResult> {
  /** Earliest clock time this item may next be attempted (for per-item backoff). */
  nextEligibleAt: number
}

export class ExtractionQueue<TResult = unknown> {
  private items: InternalItem<TResult>[]
  private cfg: QueueConfig
  private read: (index: number) => Promise<ReadOutcome<TResult>>
  private onUpdate: (snap: QueueSnapshot<TResult>) => void

  private pausedUntil = 0
  private lastStartAt = 0
  private consecutiveQuotaPauses = 0
  private quotaBlocked = false
  private phase: QueuePhase = "idle"

  constructor(opts: {
    files: { index: number; fileName: string }[]
    read: (index: number) => Promise<ReadOutcome<TResult>>
    onUpdate: (snap: QueueSnapshot<TResult>) => void
    config?: Partial<QueueConfig>
  }) {
    this.cfg = { ...DEFAULT_QUEUE_CONFIG, ...opts.config }
    this.read = opts.read
    this.onUpdate = opts.onUpdate
    this.items = opts.files.map((f) => ({
      index: f.index,
      fileName: f.fileName,
      status: "pending",
      attempts: 0,
      documentCount: 0,
      nextEligibleAt: 0,
      result: null,
    }))
  }

  /** Drain the queue. Resolves when every item is done or permanently failed. */
  async run(): Promise<QueueSnapshot<TResult>> {
    const workers = Array.from({ length: Math.max(1, this.cfg.concurrency) }, () => this.worker())
    await Promise.all(workers)
    this.phase = "done"
    this.emit()
    return this.snapshot()
  }

  /** Re-open specific items (or all failed) for another pass — the manual fallback. */
  reopen(indices?: number[]) {
    this.quotaBlocked = false
    this.consecutiveQuotaPauses = 0
    for (const it of this.items) {
      const target = indices ? indices.includes(it.index) : it.status === "failed"
      if (target && it.status === "failed") {
        it.status = "pending"
        it.attempts = 0
        it.nextEligibleAt = 0
      }
    }
    this.emit()
  }

  snapshot(): QueueSnapshot<TResult> {
    return {
      items: this.items.map((it) => ({ ...it })),
      phase: this.phase,
      processed: this.items.filter((it) => it.status === "done" || it.status === "failed").length,
      resumeInMs: Math.max(0, this.pausedUntil - this.cfg.now()),
      quotaBlocked: this.quotaBlocked,
    }
  }

  private emit() {
    this.onUpdate(this.snapshot())
  }

  /** Atomically claim the next item eligible to run right now (or null). */
  private claim(): InternalItem<TResult> | null {
    const now = this.cfg.now()
    for (const it of this.items) {
      if ((it.status === "pending" || it.status === "waiting") && it.nextEligibleAt <= now) {
        it.status = "reading"
        return it
      }
    }
    return null
  }

  /** Soonest future time an item becomes eligible (for sleeping), or null if none pending. */
  private soonestEligible(): number | null {
    let soonest: number | null = null
    for (const it of this.items) {
      if (it.status === "pending" || it.status === "waiting") {
        soonest = soonest == null ? it.nextEligibleAt : Math.min(soonest, it.nextEligibleAt)
      }
    }
    return soonest
  }

  private hasWork(): boolean {
    return this.items.some((it) => it.status === "pending" || it.status === "waiting" || it.status === "reading")
  }

  private async worker() {
    for (;;) {
      if (this.quotaBlocked) return
      if (!this.hasWork()) return

      // 1) Respect an active global pause (rate-limit/quota backoff).
      const pauseLeft = this.pausedUntil - this.cfg.now()
      if (pauseLeft > 0) {
        this.phase = "rate_limited"
        this.emit()
        await this.cfg.sleep(Math.min(pauseLeft, 1000)) // wake ~1s to refresh countdown
        continue
      }

      // 2) Claim an item that is eligible now.
      const item = this.claim()
      if (!item) {
        // Nothing eligible this instant. If items are only in backoff, wait for
        // the soonest; if others are mid-flight, yield briefly.
        const soonest = this.soonestEligible()
        if (soonest == null) {
          if (this.hasWork()) {
            await this.cfg.sleep(50)
            continue
          }
          return
        }
        const wait = Math.max(0, soonest - this.cfg.now())
        this.phase = this.items.some((it) => it.status === "waiting") ? "retrying" : "waiting_capacity"
        this.emit()
        await this.cfg.sleep(Math.min(Math.max(wait, 25), 1000))
        continue
      }

      // 3) Enforce minimum spacing between request STARTS across the whole queue.
      const sinceLast = this.cfg.now() - this.lastStartAt
      if (sinceLast < this.cfg.minSpacingMs) {
        await this.cfg.sleep(this.cfg.minSpacingMs - sinceLast)
      }
      this.lastStartAt = this.cfg.now()
      item.attempts += 1
      this.phase = item.attempts > 1 ? "retrying" : "reading"
      this.emit()

      // 4) Read.
      let outcome: ReadOutcome<TResult>
      try {
        outcome = await this.read(item.index)
      } catch {
        outcome = { ok: false, documentCount: 0, errorReason: "gateway", retryable: true }
      }

      // 5) Apply the outcome.
      if (outcome.ok) {
        item.status = "done"
        item.result = outcome.result ?? null
        item.documentCount = outcome.documentCount
        item.incomplete = outcome.incomplete
        item.errorReason = null
        this.consecutiveQuotaPauses = 0 // progress resets the quota-block counter
        this.emit()
        continue
      }

      item.errorReason = outcome.errorReason
      item.retryable = outcome.retryable
      const reason = outcome.errorReason ?? "unknown"

      // Quota / rate limit → pause the WHOLE queue and re-queue this item.
      if (QUOTA_REASONS.has(reason) && outcome.retryable !== false) {
        this.consecutiveQuotaPauses += 1
        const backoff =
          outcome.retryAfterMs ??
          Math.min(this.cfg.defaultQuotaPauseMs * 2 ** (this.consecutiveQuotaPauses - 1), this.cfg.maxBackoffMs)
        this.pausedUntil = this.cfg.now() + backoff
        item.status = "waiting"
        item.nextEligibleAt = 0 // eligible as soon as the global pause clears
        // Persistent free-tier gate: stop burning the batch; surface guidance.
        if (this.consecutiveQuotaPauses >= this.cfg.maxConsecutiveQuotaPauses) {
          this.quotaBlocked = true
          for (const it of this.items) {
            if (it.status === "pending" || it.status === "waiting") {
              it.status = "failed"
              it.errorReason = "quota_exceeded"
              it.retryable = true
            }
          }
        }
        this.emit()
        continue
      }

      // Transient (non-quota) → per-item exponential backoff + jitter, capped.
      if (RETRYABLE_TRANSIENT.has(reason) && outcome.retryable !== false && item.attempts < this.cfg.maxAttemptsPerItem) {
        const raw = Math.min(this.cfg.baseBackoffMs * 2 ** (item.attempts - 1), this.cfg.maxBackoffMs)
        const jittered = Math.round(raw / 2 + Math.random() * (raw / 2))
        item.status = "waiting"
        item.nextEligibleAt = this.cfg.now() + jittered
        this.emit()
        continue
      }

      // Permanent, or retries exhausted → give up on this item only.
      item.status = "failed"
      item.documentCount = 0
      this.emit()
    }
  }
}
