// What --autocompact value is each agent's LIVE process actually running with?
//
// AUTOCOMPACT_TOKENS is read from .env at dashboard boot and passed on the
// command line when an agent STARTS. An agent already running keeps whatever it
// was launched with, for as long as it lives -- and these sessions live for
// days.
//
// That gap cost most of a day (Boss, 2026-08-14). The setting was raised to
// 250000 so the gate at 120000 would act first, the card duly showed 250000 --
// and usalackor went on compacting every 2-3 minutes, because its process had
// been started the previous evening with --autocompact 100000 and was firing at
// ~69k. Measured: 68 auto-compactions in 43 hours, in bursts of one every
// ~2.5 minutes whenever the agent was working. From the dashboard the setting
// looked applied; from the agent's side nothing had changed.
//
// So the card reads the number out of /proc rather than repeating the one we
// hope is in effect. A disagreement is then visible as a disagreement -- "this
// takes effect at the next start" -- instead of looking like a broken setting.
//
// Attribution is by TMUX SESSION, not by CLAUDE_CONFIG_DIR. The config dir was
// the obvious key and it is wrong: measured on this install, 13 of 15 agents
// share the default config dir (only the two extra Claude ACCOUNTS have their
// own), so one process's flag would have been reported as all thirteen agents'
// -- including agents that are not running at all. The tmux session is what
// actually belongs to one agent.
//
// Best-effort throughout: /proc may be unreadable, tmux may be absent, the
// process may exit between two reads, a remote agent has no local process at
// all. Every failure means "unknown" (null), never a wrong number, never a
// throw.
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { makeLazyBinResolver } from '../platform.js'
import { logger } from '../logger.js'

const tmuxBin = makeLazyBinResolver('tmux')

const TTL_MS = 5_000
let cache: { at: number; bySession: Map<string, number> } | null = null

/** One live process, reduced to what the fold needs. */
export interface ProcessArgs {
  argv: string[]
  /** tmux session this process runs in, or null when it could not be placed. */
  session: string | null
}

/**
 * Pure half: fold a list of processes into tmux session -> autocompact tokens.
 *
 * A session can hold more than one claude (a --continue probe alongside the
 * long-running one). They are started by the same code path with the same flag,
 * so any of them is representative; if they DISAGREE the agent is only partly
 * restarted, and the LOWER number is the one that will compact first -- which is
 * exactly what the owner needs to be told about.
 *
 * A process that could not be placed in a session is dropped. Guessing would
 * put one agent's number on another agent's card, which is the failure this
 * module exists to remove.
 */
export function foldAutocompactBySession(procs: Iterable<ProcessArgs>): Map<string, number> {
  const bySession = new Map<string, number>()
  for (const { argv, session } of procs) {
    if (!session) continue
    if (!argv.length || !/(^|\/)claude$/.test(argv[0])) continue
    const i = argv.indexOf('--autocompact')
    if (i < 0 || i + 1 >= argv.length) continue
    const tokens = Number(argv[i + 1])
    if (!Number.isFinite(tokens) || tokens <= 0) continue
    const prev = bySession.get(session)
    if (prev === undefined || tokens < prev) bySession.set(session, tokens)
  }
  return bySession
}

/** Parent pid from /proc/<pid>/stat. The comm field can contain spaces and
 *  parentheses, so everything up to the LAST ')' is skipped. */
function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    const ppid = Number(rest[1])          // state, ppid, ...
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null
  } catch { return null }
}

/** tmux pane pid -> session name, for every pane on the local server. */
function panePidToSession(): Map<number, string> {
  const out = new Map<number, string>()
  try {
    const listed = execFileSync(tmuxBin(), ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'],
      { encoding: 'utf-8', timeout: 3000 })
    for (const line of listed.split('\n')) {
      const [session, pid] = line.split('\t')
      const n = Number(pid)
      if (session && Number.isFinite(n)) out.set(n, session)
    }
  } catch (err) {
    // No tmux server, or it is not answering. Nothing can be attributed.
    logger.debug({ err }, 'running-autocompact: tmux list-panes failed')
  }
  return out
}

/** Walk up the process tree until a pid is a known tmux pane. Bounded: a
 *  cycle or a very deep tree must not spin. */
function sessionOf(pid: number, panes: Map<number, string>): string | null {
  let cur: number | null = pid
  for (let hops = 0; cur !== null && cur > 1 && hops < 20; hops++) {
    const session = panes.get(cur)
    if (session) return session
    cur = parentOf(cur)
  }
  return null
}

function* readProcs(panes: Map<number, string>): Generator<ProcessArgs> {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let argv: string[]
    try {
      argv = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').split('\0').filter(Boolean)
    } catch { continue }
    if (!argv.length || !/(^|\/)claude$/.test(argv[0])) continue
    // Walking the tree is the expensive part, so it happens only for a claude
    // process that actually carries the flag.
    if (!argv.includes('--autocompact')) continue
    yield { argv, session: sessionOf(Number(entry), panes) }
  }
}

function scanRunning(nowMs: number): Map<string, number> {
  if (cache && nowMs - cache.at < TTL_MS) return cache.bySession
  let bySession = new Map<string, number>()
  try {
    const panes = panePidToSession()
    bySession = panes.size ? foldAutocompactBySession(readProcs(panes)) : bySession
  } catch (err) {
    logger.debug({ err }, 'running-autocompact: /proc scan failed')
  }
  cache = { at: nowMs, bySession }
  return bySession
}

/**
 * The --autocompact value the live process in this tmux session is using, or
 * null when there is nothing to ask (stopped agent, remote agent, a CLI build
 * without the flag, no tmux server).
 */
export function readRunningAutocompact(session: string, nowMs = Date.now()): number | null {
  return scanRunning(nowMs).get(session) ?? null
}

/** Test seam. */
export function _resetRunningAutocompactCache(): void { cache = null }
