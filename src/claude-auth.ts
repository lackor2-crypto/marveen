// Pure parsing for the dashboard-driven Claude Code account switch (kanban #52,
// 61e9ed2b).
//
// Why this exists (Boss, 2026-08-07): logging a Claude account in meant opening
// the WSL terminal and running the login by hand. He wanted it on the Accounts
// page instead, one button, "ne kelljen Ubuntu terminalba menni".
//
// NOT a switch (Boss, 2026-08-12, correcting the card): accounts run in
// PARALLEL here -- three are logged in as this is written, and he wants to be
// able to add a tenth. Adding a login must therefore leave every existing one
// untouched. See the "parallel accounts" section at the bottom.
//
// What the CLI actually does, measured before any of this was written (2026-08-12,
// `claude auth login --claudeai` under a PTY with an isolated CLAUDE_CONFIG_DIR):
//
//   Opening browser to sign in...
//   If the browser didn't open, visit: <OSC-8 hyperlink><URL><URL></OSC-8>
//   Paste code here if prompted >
//
// Two consequences shape the whole design:
//
//   1. It needs a TTY. Spawned with plain pipes it prints NOTHING and exits on
//      SIGTERM with no output at all -- which is why the runner drives it inside
//      a tmux window and scrapes the pane, the same way everything else in this
//      fork talks to a Claude process.
//
//   2. The redirect_uri is https://platform.claude.com/oauth/code/callback -- a
//      HOSTED page, not a localhost listener. The browser therefore shows the
//      code to the human, and the CLI waits for it to be pasted back. There is
//      no callback we could intercept, so the "no copying anything by hand" half
//      of the original UX wish is not reachable through this CLI; what IS
//      reachable is that the DASHBOARD does the waiting and the detecting, so
//      the user pastes one code into the page instead of running a terminal
//      session. See the card comment for the full reasoning.
//
// This module is dependency-free so the parsing is testable without tmux, a
// browser or an account. The I/O lives in src/web/claude-auth-runner.ts.

/** What the login pane is currently asking for. */
export type LoginPhase =
  | 'starting'    // spawned, nothing recognisable on the pane yet
  | 'awaiting-code' // the URL is up and the CLI is waiting for the pasted code
  | 'working'     // code submitted, the CLI has not answered yet
  | 'done'        // auth status confirms a logged-in account
  | 'failed'      // the pane reported an error, or the process died

export interface LoginPaneState {
  phase: LoginPhase
  /** The authorize URL, once it appears. Never logged: it carries the PKCE
   *  challenge and the state parameter. */
  url: string | null
  /** A human-readable error line lifted from the pane, when there is one. */
  error: string | null
}

/** Terminal escape sequences, including OSC-8 hyperlinks (ESC ] 8 ; ; URL ST).
 *  tmux gives these back verbatim, and the URL we want is inside one. */
const ANSI_CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const OSC_8 = /\x1b\]8;;([^\x1b\x07]*)(?:\x07|\x1b\\)/g

/**
 * The authorize URL from a captured pane.
 *
 * It shows up TWICE in a row -- once as the hyperlink target inside the OSC-8
 * escape, once as the visible label -- so the naive "first https:// to
 * whitespace" grab returns the two concatenated into one unusable string. Both
 * forms are collected and the first complete one wins.
 *
 * `capture-pane -J` is what makes this possible at all: the URL is ~500
 * characters and the pane wraps it across lines, so without joining, every
 * capture would yield fragments.
 */
export function extractAuthUrl(pane: string): string | null {
  const candidates: string[] = []
  for (const m of pane.matchAll(OSC_8)) {
    if (m[1] && m[1].startsWith('http')) candidates.push(m[1])
  }
  // Fallback for a terminal that dropped the hyperlink escape: take the visible
  // text, and stop at the point where the SAME url starts over (the duplicate).
  const plain = pane.replace(OSC_8, '').replace(ANSI_CSI, '')
  const m = /https:\/\/\S*oauth\S*/.exec(plain)
  if (m) {
    const raw = m[0]
    const second = raw.indexOf('https://', 1)
    candidates.push(second > 0 ? raw.slice(0, second) : raw)
  }
  for (const c of candidates) {
    // A complete authorize URL always carries the state parameter; a fragment
    // captured mid-render usually does not.
    if (c.includes('state=')) return c
  }
  return candidates[0] ?? null
}

/** Strip escapes so the pane can be matched as plain text. */
export function plainPane(pane: string): string {
  return pane.replace(OSC_8, '').replace(ANSI_CSI, '').replace(/\r/g, '')
}

const ERROR_MARKERS = [
  /error:?\s+(.+)/i,
  /failed to\s+(.+)/i,
  /invalid code/i,
  /expired/i,
]

/**
 * Read the pane into a phase.
 *
 * `codeSubmitted` is the runner's own memory: the pane keeps showing the paste
 * prompt after the code goes in, so the text alone cannot tell "waiting for a
 * code" from "already got one and thinking".
 */
export function readLoginPane(pane: string, codeSubmitted: boolean): LoginPaneState {
  const text = plainPane(pane)
  const url = extractAuthUrl(pane)

  for (const re of ERROR_MARKERS) {
    const m = re.exec(text)
    if (m) return { phase: 'failed', url, error: (m[1] ?? m[0]).trim().slice(0, 200) }
  }
  if (/login successful|logged in|already authenticated/i.test(text)) {
    return { phase: 'done', url, error: null }
  }
  if (codeSubmitted) return { phase: 'working', url, error: null }
  if (url && /paste code here/i.test(text)) return { phase: 'awaiting-code', url, error: null }
  return { phase: 'starting', url, error: null }
}

/** What `claude auth status --json` tells us, reduced to what the page shows. */
export interface AuthIdentity {
  loggedIn: boolean
  email: string | null
  subscriptionType: string | null
  authMethod: string | null
  orgName: string | null
}

export const UNKNOWN_IDENTITY: AuthIdentity = Object.freeze({
  loggedIn: false, email: null, subscriptionType: null, authMethod: null, orgName: null,
})

/** Parse `claude auth status --json`. Anything unparseable reads as logged-out
 *  rather than throwing: the page must render even when the CLI is missing. */
export function parseAuthStatus(raw: string): AuthIdentity {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object') return UNKNOWN_IDENTITY
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
    return {
      loggedIn: o.loggedIn === true,
      email: str(o.email),
      subscriptionType: str(o.subscriptionType),
      authMethod: str(o.authMethod),
      orgName: str(o.orgName),
    }
  } catch {
    return UNKNOWN_IDENTITY
  }
}

/**
 * Is the NEW login finished?
 *
 * This is the automatic success detection: the dashboard polls the CLI's own
 * status instead of making anyone confirm anything.
 *
 * The check runs against a FRESH, empty config dir (see below on why accounts
 * are parallel rather than swapped), so "logged in at all" is the whole signal
 * -- there is no previous account in that directory to distinguish it from.
 */
export function isLoginComplete(now: AuthIdentity): boolean {
  return now.loggedIn && now.email !== null
}

// --- parallel accounts ------------------------------------------------------
//
// Boss, 2026-08-12, correcting the card's own title: "itt nem fiokot akarok
// valtani, hanem egy ilyen parhuzamos bejelentkezest, tehat hogy ha akarom,
// akkor tiz fiokkal is be tudjak jelentkezni". Right now three accounts are
// logged in at once, and that is the point -- an account is not a mode the
// install switches between.
//
// The mechanism already exists: store/claude-plans.json gives every named login
// its own CLAUDE_CONFIG_DIR, and agents reference a plan by id. So "add an
// account" means log in inside a NEW config dir and register it. Nothing
// existing is touched, which is exactly why ten of them can coexist.

/** Plan ids are HTML option values and are looked up by string equality, so the
 *  registry restricts them to a boring charset. Derive one from whatever the
 *  operator typed rather than making them invent an identifier. */
export function planIdFromLabel(label: string, taken: string[] = []): string {
  const base = label
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // ekezet -> ASCII
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const seed = base || 'fiok'
  if (!taken.includes(seed)) return seed
  for (let i = 2; i < 100; i++) {
    if (!taken.includes(`${seed}-${i}`)) return `${seed}-${i}`
  }
  return `${seed}-${Date.now()}`
}

export interface NewPlanEntry {
  id: string
  label: string
  configDir: string
  planType: 'personal' | 'team'
  channelsAllowed: boolean
}

/** The registry row for a freshly logged-in account. Conservative defaults:
 *  a new login is personal and NOT cleared for channels until the operator says
 *  so -- a team seat that quietly starts answering Telegram is the mistake this
 *  avoids. */
export function buildPlanEntry(id: string, label: string, configDir: string): NewPlanEntry {
  return { id, label: label.trim() || id, configDir, planType: 'personal', channelsAllowed: false }
}
