// Live Telegram progress mirror -- the pure half (kanban #416).
//
// Rebuilt from upstream d3c5fdf5 / 2997022b (scripts/telegram-live-progress.py)
// onto OUR placeholder system instead of beside it. Upstream runs a separate
// systemd daemon that owns its own "thinking" message; this fork already has a
// per-turn placeholder ("✍️ Dolgozom rajta…") created by the UserPromptSubmit
// hook, cleared by the reply/Stop hooks, and turned into an error by the
// watchdog when the session dies. That lifecycle is kept exactly as it is. The
// mirror only EDITS the text of a placeholder that is already out, so the owner
// sees what the terminal shows (`✻ Incubating… (3m 44s · ↓ 13.1k tokens)`).
//
// Everything here is a pure function of its inputs, so the tests drive the
// exact branches the runner takes -- no tmux, no Telegram, no store.
import { detectPaneState } from './pane-state.js'

export type ProgressMode = 'silent' | 'indicator' | 'verbose'
export const PROGRESS_MODES: readonly ProgressMode[] = ['silent', 'indicator', 'verbose']

export function parseProgressMode(raw: unknown): ProgressMode {
  const v = String(raw ?? '').trim().toLowerCase()
  return (PROGRESS_MODES as readonly string[]).includes(v) ? (v as ProgressMode) : 'indicator'
}

export type PaneActivity = { kind: 'live' | 'background'; text: string }

// The status line: one glyph, a space, then the verb and the live counter --
// `✽ Incubating… (55s · ↓ 2.6k tokens)`, and on current Claude Code builds
// `· Churning… (4m 33s · ↓ 23.5k tokens)`. Upstream matched a fixed glyph set,
// which misses the `·` shape this host renders, so any single non-letter glyph
// is accepted and the counter shape decides. Box chrome (❯ │ ⎿ ─) never counts.
const STATUS_RE = /^([^\p{L}\p{N}\s❯>│⎿─])\s+(.+)$/u
const STATUS_DETAIL_RE = /\(\d|for \d+s|still running/
// Same window pane-state.ts scans for its busy signals: a stale counter from a
// finished turn higher up in the scrollback is not the live one.
const STATUS_REGION_LINES = 12

// Idle footer that still carries background work. The prefix ALONE is not an
// anchor: scrollback can quote "bypass permissions on · 1 shell" verbatim, and
// reading that as running work would park a message in the chat that never
// goes away. Either the line starts with the mode glyphs (only the real footer
// does), or one of Claude Code's real tail actions follows -- the same test as
// IDLE_FOOTER_RX in src/pane-state.ts.
const BG_FOOTER_RE = /^\s*⏵⏵ bypass permissions on|bypass permissions on[^\n]*?(?:ctrl\+t|↓ to manage)/
const BG_COUNTER_RE = /\d+ (?:shells?|tasks?|monitors?)/g

const TEXT = {
  hu: { working: 'dolgozom…', background: 'háttérfolyamat fut' },
  en: { working: 'working…', background: 'background work running' },
} as const

export type Lang = keyof typeof TEXT
export function langOf(raw: unknown): Lang {
  return raw === 'en' ? 'en' : 'hu'
}

/**
 * What the agent's pane is doing, or null when it is idle.
 *
 * 'live' = a turn is in flight (the bottom bar carries "esc to interrupt" for
 * its whole duration -- the spinner line above it is only redrawn now and then,
 * so a missed frame must never look idle). 'background' = no turn in flight,
 * but a shell / monitor / sub-agent is still running.
 */
export function classifyPane(pane: string | null | undefined, lang: Lang = 'hu'): PaneActivity | null {
  if (!pane) return null
  const lines = pane.split('\n')
  // Busy is pane-state.ts's verdict, not a second opinion: upstream gated on
  // "esc to interrupt", which current Claude Code builds no longer print while
  // a turn runs (measured on this host, #416) -- the mirror would never fire.
  if (detectPaneState(pane) === 'busy') {
    const region = lines.slice(-STATUS_REGION_LINES - 8)
    for (let i = region.length - 1; i >= 0; i--) {
      const m = STATUS_RE.exec(region[i].trim())
      if (!m) continue
      const text = m[2].trim()
      if (STATUS_DETAIL_RE.test(text)) return { kind: 'live', text }
    }
    const busy = /(\d+ shells?|\d+ tasks?|monitor)/.exec(lines.slice(-6).join('\n'))
    return { kind: 'live', text: busy ? `${TEXT[lang].working} (${busy[1]})` : TEXT[lang].working }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!BG_FOOTER_RE.test(lines[i])) continue
    const counters = lines[i].match(BG_COUNTER_RE)
    return counters ? { kind: 'background', text: `${TEXT[lang].background} (${counters.join(', ')})` } : null
  }
  return null
}

/**
 * The text an existing placeholder should carry while the turn runs. The
 * placeholder's own base text stays first, so the owner still reads "working
 * on it" and the mirror only adds the live detail. Null = leave it alone.
 */
export function placeholderLiveText(base: string, activity: PaneActivity | null): string | null {
  if (!activity || activity.kind !== 'live') return null
  return `${base}\n✻ ${activity.text}`
}

/** The separate, silent message shown when only background work is alive. */
export function backgroundText(activity: PaneActivity | null): string | null {
  return activity && activity.kind === 'background' ? `⏳ ${activity.text}` : null
}

/**
 * Throttle for edits: Telegram rate-limits edits per chat, and the spinner
 * text changes every second. Edit only when the text changed AND enough time
 * passed since the last edit of that message.
 */
export function shouldEdit(prevText: string | undefined, nextText: string, lastEditMs: number, nowMs: number, throttleMs: number): boolean {
  if (prevText === nextText) return false
  return nowMs - lastEditMs >= throttleMs
}

const norm = (t: unknown) => String(t ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, 400)

/**
 * Verbose mode: the assistant's visible text blocks from new transcript lines,
 * minus anything that also went out as a real Telegram reply in the same span
 * (the owner would otherwise get the same paragraph twice).
 */
export function extractThoughts(jsonlLines: string[]): string[] {
  const out: string[] = []
  const sent: string[] = []
  for (const line of jsonlLines) {
    let d: any
    try { d = JSON.parse(line) } catch { continue }
    if (!d || d.type !== 'assistant') continue
    const content = d.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c?.type === 'tool_use' && String(c.name ?? '').includes('telegram')) {
        sent.push(norm(c.input?.text))
      } else if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        out.push(c.text.trim())
      }
    }
  }
  return out.filter(t => !sent.some(s => s && (norm(t) === s || norm(t).startsWith(s.slice(0, 120)))))
}

export function thoughtMessage(text: string, max = 600): string {
  return `▸ ${text.length <= max ? text : text.slice(0, max) + '…'}`
}
