/**
 * A video render takes minutes (a stabilised, zoomed 3-minute cut ran 5 minutes), far longer than a page, a phone connection or a
 * proxy keeps one request open. So the editor starts the render as a JOB and asks how far it is; the agent keeps the old
 * "wait for the file" call. One job per work item, kept in memory: a restart of the dashboard ends it, and the status then
 * says "nothing running" (the editor tells the owner the render was interrupted).
 */
export type RenderJobState = 'running' | 'done' | 'error'

export interface RenderJob<R = unknown> {
  id: string
  itemId: string
  state: RenderJobState
  /** 0..1 */
  progress: number
  startedAt: number
  finishedAt: number | null
  /** What the finished job produced (the same body the waiting call returns), or the failure. */
  result: R | null
  error: { status: number; code: string; detail: string | null } | null
}

const jobs = new Map<string, RenderJob>()
/** A finished job stays readable for this long, so a slow poll or a reload still gets the answer. */
export const RENDER_JOB_KEEP_MS = 30 * 60_000

function sweep(now: number): void {
  for (const [k, j] of jobs) if (j.state !== 'running' && j.finishedAt !== null && now - j.finishedAt > RENDER_JOB_KEEP_MS) jobs.delete(k)
}

export function getRenderJob(itemId: string): RenderJob | null {
  sweep(Date.now())
  return jobs.get(itemId) ?? null
}

/** The public face of a job (no result body): what a poll needs. */
export function jobStatus(j: RenderJob | null, now = Date.now()): { id: string; state: RenderJobState; progress: number; elapsed: number; error: RenderJob['error'] } | null {
  if (!j) return null
  return { id: j.id, state: j.state, progress: j.progress, elapsed: Math.max(0, Math.round(((j.finishedAt ?? now) - j.startedAt) / 1000)), error: j.error }
}

/**
 * Starts `run` in the background. Returns null when a job of this item is already running.
 * `run` reports progress and returns the result body, or throws a `{status, code, detail}` failure.
 */
export function startRenderJob<R>(itemId: string, run: (progress: (fraction: number) => void) => Promise<R>): RenderJob<R> | null {
  const old = jobs.get(itemId)
  if (old && old.state === 'running') return null
  const job: RenderJob<R> = { id: `${itemId}-${Date.now().toString(36)}`, itemId, state: 'running', progress: 0, startedAt: Date.now(), finishedAt: null, result: null, error: null }
  jobs.set(itemId, job as RenderJob)
  void (async () => {
    try {
      job.result = await run((f) => { if (Number.isFinite(f)) job.progress = Math.max(job.progress, Math.min(1, Math.max(0, f))) })
      job.progress = 1
      job.state = 'done'
    } catch (e) {
      const x = e as { status?: number; code?: string; detail?: string | null }
      job.error = { status: x.status ?? 500, code: x.code ?? 'video_failed', detail: x.detail ?? (e instanceof Error ? e.message : null) }
      job.state = 'error'
    } finally {
      job.finishedAt = Date.now()
    }
  })()
  return job
}

/** Tests only. */
export function _clearRenderJobs(): void {
  jobs.clear()
}
