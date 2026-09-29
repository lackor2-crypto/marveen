/**
 * THE CODE BRIDGE'S TOOL RUNS, ONE BY ONE, IN THE WORKBENCH CHAT (kanban #434).
 *
 * Boss, 2026-09-29 ("A"): the VS Code code bridge showed a single "code-bridge"
 * row in the tool-runs panel while the real work (Read, Bash, Edit, ...) was
 * invisible. The worker cannot stream those steps (its loop is inside the
 * task), but the Claude Code it drives writes every tool call into its own
 * transcript (`<sid>.jsonl`), and that file is readable here. This feed reads
 * the transcript INCREMENTALLY (only the bytes appended since the last poll)
 * and turns its `tool_use` / `tool_result` rows into the same `tool` events the
 * live session emits -- so the panel renders them unchanged.
 *
 * One conversation can carry many tasks (a resumed tab), so rows older than
 * the task's start are skipped: the panel shows THIS turn's runs only.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { OrchestratorEvent } from './orchestrator.js'
import { mapStreamLine, newStreamState } from './live-session.js'

/** The first read starts at most this far from the end: the task has just
 *  started, its rows are at the tail -- and a transcript can be 150 MB. */
const FIRST_READ_MAX_BYTES = 4 * 1024 * 1024
/** One poll never reads more than this (a burst is picked up next round). */
const POLL_MAX_BYTES = 8 * 1024 * 1024
/** Rows stamped slightly before the task start still belong to it (the
 *  worker's clock and the claim time are not the same instant). */
const START_SLACK_MS = 5_000

export interface TranscriptToolFeed {
  /**
   * The tool events appended to `path` since the previous call. With
   * `finish`, runs that never got a result are closed with that status, so
   * the panel does not spin forever after the task ended.
   */
  read(path: string | null, finish?: 'ok' | 'error'): OrchestratorEvent[]
}

export function createTranscriptToolFeed(sinceMs: number): TranscriptToolFeed {
  const st = newStreamState()
  let file: string | null = null
  let offset = -1
  let carry = ''

  const readNew = (path: string): string => {
    let fd: number | null = null
    try {
      const size = statSync(path).size
      if (file !== path) { file = path; offset = -1; carry = '' }
      if (offset < 0) offset = Math.max(0, size - FIRST_READ_MAX_BYTES)
      if (size < offset) { offset = 0; carry = '' } // rewritten: start over
      const len = Math.min(size - offset, POLL_MAX_BYTES)
      if (len <= 0) return ''
      const buf = Buffer.alloc(len)
      fd = openSync(path, 'r')
      const n = readSync(fd, buf, 0, len, offset)
      offset += n
      return buf.subarray(0, n).toString('utf8')
    } catch {
      return '' // unreadable now = nothing new; the next poll tries again
    } finally {
      if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
    }
  }

  return {
    read(path, finish) {
      const out: OrchestratorEvent[] = []
      if (path) {
        const lines = (carry + readNew(path)).split('\n')
        // The last piece may be a half-written row: keep it for the next poll.
        carry = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let ts = NaN
          try { ts = Date.parse(String((JSON.parse(line) as { timestamp?: unknown }).timestamp ?? '')) } catch { continue }
          if (!Number.isFinite(ts) || ts < sinceMs - START_SLACK_MS) continue
          for (const ev of mapStreamLine(line, st).events) if (ev.type === 'tool') out.push(ev)
        }
      }
      if (finish) {
        for (const name of st.toolNames.values()) out.push({ type: 'tool', name, status: finish })
        st.toolNames.clear()
      }
      return out
    },
  }
}
