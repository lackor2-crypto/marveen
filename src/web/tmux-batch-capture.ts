// One tmux call for every pane captured in the same turn of the event loop.
//
// Why (#390, live CPU profile 2026-09-25): starting a child process blocks the
// event loop for the fork itself -- median 18 ms, up to 200 ms on this WSL
// host -- even through the ASYNC execFile. /api/agents/activity, polled every
// 3 s, refreshed each running agent's pane with its own `tmux capture-pane`:
// 715 spawns and 5.1 s of frozen server in 190 s. The answers were always
// fresh, only the forks were many.
//
// So a capture asked for now is queued, and on the next setImmediate the whole
// queue goes out as ONE tmux command sequence:
//   display-message -p <mark0> ; capture-pane -p -t s0 ; display-message -p <mark1> ; ...
// Every caller still gets a capture taken at the moment it asked -- no cache,
// no older picture -- only the fork is shared.
//
// tmux stops a command sequence at the first failing command (a session that
// went away). A pane counts as answered only when the NEXT mark arrived (the
// last one: when tmux exited 0). The first unanswered one is captured on its
// own, so a missing session answers null exactly as a single capture would,
// and the panes after it go out as a new batch.
import { randomBytes } from 'node:crypto'

/** Runs tmux with `args`; resolves ok=false on any error, with what stdout had. */
export type TmuxRun = (args: string[]) => Promise<{ ok: boolean; out: string }>

/** `flags`: the capture-pane flags after the target (`-p`, or `-e -p` for the colour view). */
export function batchCaptureArgs(sessions: string[], nonce: string, flags: string[] = ['-p']): string[] {
  const args: string[] = []
  sessions.forEach((s, i) => {
    if (i > 0) args.push(';')
    args.push('display-message', '-p', markOf(nonce, i), ';', 'capture-pane', '-t', s, ...flags)
  })
  return args
}

function markOf(nonce: string, i: number): string {
  return `@@marveen-capture-${nonce}-${i}@@`
}

/**
 * Split a batch output back into per-pane captures. undefined = not proven
 * complete (the caller captures that one on its own).
 */
export function splitBatchOutput(out: string, count: number, nonce: string, exitedOk: boolean): (string | undefined)[] {
  // Each mark sits on a line of its own, and a capture's text ends with a
  // newline, so mark i+1 always starts a line right after capture i.
  const starts: number[] = []
  let from = 0
  for (let i = 0; i < count; i++) {
    const head = markOf(nonce, i) + '\n'
    const at = out.startsWith(head, from) && (from === 0 || out[from - 1] === '\n') ? from : out.indexOf('\n' + head, from) + 1
    if (at <= 0 && !(at === 0 && out.startsWith(head))) break
    starts.push(at)
    from = at + head.length
  }
  const res: (string | undefined)[] = []
  for (let i = 0; i < count; i++) {
    if (i >= starts.length) { res.push(undefined); continue }
    const body = starts[i] + markOf(nonce, i).length + 1
    if (i + 1 < starts.length) res.push(out.slice(body, starts[i + 1]))
    else res.push(i === count - 1 && exitedOk ? out.slice(body) : undefined)
  }
  return res
}

interface Waiter { session: string; resolve: (v: string | null) => void }

/**
 * `capture(session)` resolves to the pane text (or null on error), like a
 * single `tmux capture-pane -p -t session`; captures asked for in the same
 * event-loop turn share one tmux process.
 */
export function makeBatchedCapture(run: TmuxRun, single: (session: string) => Promise<string | null>, flags: string[] = ['-p']) {
  let queue: Waiter[] = []
  // The panes up to the first failing one come from the batch; that one is
  // captured on its own (so it answers exactly as a single capture would), and
  // the rest go out as a new batch.
  const captureAll = async (sessions: string[], answers: Map<string, string | null>): Promise<void> => {
    if (!sessions.length) return
    if (sessions.length === 1) { answers.set(sessions[0], await single(sessions[0])); return }
    const nonce = randomBytes(6).toString('hex')
    const r = await run(batchCaptureArgs(sessions, nonce, flags))
    const parts = splitBatchOutput(r.out, sessions.length, nonce, r.ok)
    const firstMissing = parts.findIndex((p) => p === undefined)
    const done = firstMissing < 0 ? sessions.length : firstMissing
    for (let i = 0; i < done; i++) answers.set(sessions[i], parts[i] as string)
    if (firstMissing < 0) return
    answers.set(sessions[firstMissing], await single(sessions[firstMissing]))
    await captureAll(sessions.slice(firstMissing + 1), answers)
  }
  const flush = async (): Promise<void> => {
    const batch = queue
    queue = []
    const answers = new Map<string, string | null>()
    await captureAll([...new Set(batch.map((w) => w.session))], answers)
    for (const w of batch) w.resolve(answers.get(w.session) ?? null)
  }
  return (session: string): Promise<string | null> =>
    new Promise((resolve) => {
      if (!queue.length) setImmediate(() => { void flush() })
      queue.push({ session, resolve })
    })
}
