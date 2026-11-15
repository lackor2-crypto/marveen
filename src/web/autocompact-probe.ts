// Probe of `claude --help` for the --autocompact flag, kept off the dashboard's event loop (#885).
//
// `claude --help` can take 2-20 s on a loaded machine. The old probe ran it as execFileSync on the first agent
// start after a restart, which froze the whole dashboard (stall sampler: autocompactFlag -> execFileSync). The
// first fix only warmed the probe in the background; an agent that started before the warm-up answered (the
// normal case right after a restart) still fell back to the SYNC run, and a timed-out warm-up cached "no flag"
// for the whole process lifetime. This version:
//   - remembers the answer on disk, keyed by the claude binary's mtime + size, so a restart costs a stat and a
//     small file read instead of a spawn (the binary does not change between restarts, normally),
//   - never caches a timeout as "flag unsupported" (that would silently drop the context ceiling),
//   - keeps the sync run only as the last resort (first ever run, or the binary changed AND no warm answer yet).
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface HelpRun { ok: boolean; timedOut: boolean; stdout: string }

export interface AutocompactProbeDeps {
  /** Identity of the claude binary; null when it cannot be stat-ed (then nothing is read from / written to disk). */
  binIdentity: () => { mtimeMs: number; size: number } | null
  cacheFile: string
  runHelpAsync: () => Promise<HelpRun>
  runHelpSync: () => HelpRun
  readCache?: (file: string) => string | null
  writeCache?: (file: string, data: string) => void
}

const FLAG = '--autocompact'

export function binIdentityOf(path: string): { mtimeMs: number; size: number } | null {
  try { const s = statSync(path); return { mtimeMs: s.mtimeMs, size: s.size } } catch { return null }
}

export function createAutocompactProbe(deps: AutocompactProbeDeps) {
  const readCache = deps.readCache ?? ((f: string) => { try { return readFileSync(f, 'utf-8') } catch { return null } })
  const writeCache = deps.writeCache ?? ((f: string, d: string) => {
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, d)
  })
  let supported: boolean | null = null
  let inflight: Promise<void> | null = null

  function fromDisk(): boolean | null {
    const id = deps.binIdentity()
    if (!id) return null
    const raw = readCache(deps.cacheFile)
    if (!raw) return null
    try {
      const j = JSON.parse(raw) as { mtimeMs?: number; size?: number; supported?: unknown }
      if (j.mtimeMs === id.mtimeMs && j.size === id.size && typeof j.supported === 'boolean') return j.supported
    } catch { /* corrupt cache: probe again */ }
    return null
  }

  function remember(r: HelpRun): void {
    // A timeout (or a kill) says nothing about the flag: leave it unknown so the next start probes again.
    if (!r.ok && r.timedOut) return
    supported = r.ok && r.stdout.includes(FLAG)
    const id = deps.binIdentity()
    if (id) {
      try { writeCache(deps.cacheFile, JSON.stringify({ ...id, supported })) } catch { /* the cache is an optimisation */ }
    }
  }

  return {
    /** Starts the probe without blocking. Safe to call repeatedly. */
    warm(): Promise<void> {
      if (supported !== null) return Promise.resolve()
      const d = fromDisk()
      if (d !== null) { supported = d; return Promise.resolve() }
      if (!inflight) {
        inflight = deps.runHelpAsync()
          .then((r) => { if (supported === null) remember(r) })
          .catch(() => { /* leave unknown */ })
          .finally(() => { inflight = null })
      }
      return inflight
    },
    /** Synchronous answer for the spawn command. Blocks only when nothing else knows the answer yet. */
    get(): boolean {
      if (supported !== null) return supported
      const d = fromDisk()
      if (d !== null) return (supported = d)
      let r: HelpRun
      try { r = deps.runHelpSync() } catch { r = { ok: false, timedOut: false, stdout: '' } }
      // A blocked-and-timed-out run is not repeated for this process (every start would freeze the loop again),
      // but it is not written to disk either: the next restart probes afresh.
      if (!r.ok && r.timedOut) return (supported = false)
      remember(r)
      return supported ?? false
    },
    /** For tests. */
    peek(): boolean | null { return supported },
  }
}
