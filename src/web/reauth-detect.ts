// Detect whether a Claude Code agent session needs re-authentication (/login).
//
// Szabi 2026-06-03: surface a "reauth needed" badge on the dashboard agent
// card so an expired login (which silently stops the agent from working) is
// visible at a glance, with a one-click /login button next to it.
//
// We key ONLY on distinctive multi-word strings that Claude Code itself prints
// on an auth failure -- NOT a bare "/login" token, which could appear in a
// user's chat message or an assistant reply and cause a false badge. Pure +
// exported for unit testing against captured pane fixtures.

export interface ReauthState {
  needsReauth: boolean
  reason?: string
}

// Each entry: a distinctive marker Claude Code renders on an auth failure, and
// the short reason surfaced to the UI. Ordered most-specific first.
const REAUTH_MARKERS: { rx: RegExp; reason: string; firstRunGate?: true }[] = [
  // Not a token failure: Claude Code's FIRST-RUN picker, shown when
  // ~/.claude.json lost hasCompletedOnboarding. It blocks the TUI exactly like
  // a dead login (2026-07-15 bootcamp "mass /login": the on-disk credential was
  // valid the whole time) and needs the same owner-visible badge/escalation.
  // A monitored respawn self-heals it via ensureSharedClaudeOnboarded().
  { rx: /Select login method/i, reason: 'First-run onboarding picker (Select login method)', firstRunGate: true },
  // The state the picker advances into when something blindly hits Enter on it
  // (e.g. channels.sh's first-run guard): a browser OAuth prompt no headless
  // box can complete. Same first-run-gate family, same restart heal.
  { rx: /Use the url below to sign in|Paste code here if prompted/i, reason: 'Browser sign-in screen (first-run gate)', firstRunGate: true },
  { rx: /Invalid authentication credentials/i, reason: 'Invalid authentication credentials (401)' },
  { rx: /Please run\s+\/login/i, reason: 'Please run /login' },
  { rx: /Not logged in/i, reason: 'Not logged in' },
  { rx: /\bAPI Error:\s*401\b/i, reason: 'API Error: 401' },
  { rx: /OAuth token (?:has )?expired/i, reason: 'OAuth token expired' },
  { rx: /Invalid API key/i, reason: 'Invalid API key' },
  { rx: /session has expired.*\/login/i, reason: 'Session expired' },
]

// Only scan the live tail of the pane, not the whole scrollback. A real auth
// failure shows in the active error/prompt region at the bottom; scanning the
// full capture would false-positive whenever an agent merely *discusses* these
// strings higher up -- e.g. an agent reviewing THIS code, or a chat about a 401.
// (Caught in review 2026-06-03: the reviewer's own pane was full of these
// markers from reading reauth-detect.ts and would have falsely badged.)
const TAIL_LINES = 15

// Self-quote guard (found 2026-07-13: 5 false escalations in ~18h, each
// shortly after the alert text was pasted back into the chat). The healer's
// own escalation message embeds the raw marker `reason` string verbatim, e.g.
// "... jelez (Please run /login) ...". Once that message is quoted back into
// the pane -- the owner forwarding it, the dashboard rendering it, or the
// agent discussing the bug -- it re-matches REAUTH_MARKERS against its own
// alert and re-fires, forever. These substrings are unique to
// buildEscalationMessage / buildQuietSummaryMessage in reauth-healer.ts and
// never appear in a real Claude Code CLI auth failure.
const ESCALATION_QUOTE_MARKERS: RegExp[] = [
  /ágens halott OAuth tokent jelez/i,
  /Manuális browser \/login kell a dashboardon/i,
]

function tailOf(pane: string, n: number): string {
  const lines = pane.split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

// A 15-line tail is still too coarse for a *transcript* line that scrolls with
// the conversation. Devy 2026-07-12: an agent that hit an expired token, then
// ran /login and got "Login successful", still carried the older
// "Not logged in - Please run /login" transcript result inside the tail window
// -- and the dashboard badged a healthy, logged-in agent.
//
// Claude Code renders a *live status line* directly above the input box, and
// that line -- not the scrolling transcript -- is what tracks auth state: it
// reads "Not logged in - Run /login" while broken and flips to the context
// readout once login succeeds. So when the pane has the box UI, scan only that
// live region and ignore the transcript above it. Panes without the box (print
// mode, plain captures, unit fixtures) keep the tail heuristic.
const BOX_BORDER_RX = /─{10,}/

/**
 * The live status region: the status line + the input box + the hint lines
 * under it. Returns null when the pane has no input box to anchor on.
 */
function liveStatusRegion(pane: string): string | null {
  const lines = pane.split('\n')
  const borders: number[] = []
  for (let i = lines.length - 1; i >= 0 && borders.length < 2; i--) {
    if (BOX_BORDER_RX.test(lines[i])) borders.push(i)
  }
  if (borders.length < 2) return null
  const top = Math.min(borders[0], borders[1])
  return lines.slice(Math.max(0, top - 1)).join('\n')
}

// --- Transcript wedge (added 2026-08-08 after a real incident) ---------------
//
// The live-status-region narrowing above is correct for a DEAD ON-DISK
// CREDENTIAL: Claude Code knows it has no usable token and says so in the
// status line. But it is blind to the other failure family, which is what bit
// the owner on 2026-08-08: the CLI *believes* it is authenticated (a
// CLAUDE_CODE_OAUTH_TOKEN env var was set), so the status line stays perfectly
// healthy, and the rejection only surfaces per-request, as a TRANSCRIPT line:
//
//     ● Please run /login · API Error: 401 Invalid bearer token
//
// In a tall terminal with a short conversation that line sits dozens of blank
// rows above the input box, far outside the live region -- so the old detector
// returned false and Marvin sat wedged for hours with nothing escalating.
// Verified empirically against the captured pane before this change.
//
// Scanning the transcript reopens the two false-positive holes the narrowing
// was built to close, so this check is deliberately stricter than a substring
// match on both axes:
//
//   1. ANCHORED: the marker must be the START of a rendered result line (right
//      after Claude Code's own bullet), never buried in prose. An agent that
//      merely discusses "...then it prints Please run /login..." cannot match.
//   2. SUPERSEDED: a failure that is followed later in the same transcript by a
//      successful login is history, not state. This is exactly the Devy
//      2026-07-12 case ("Not logged in" then "Login successful"), which the
//      live-region rule got right and a naive transcript scan would regress.
//
// First-run-gate markers are excluded on purpose: that picker is a full-screen
// state which always lands in the live region, and matching it in scrollback is
// the documented 2026-07-15 false positive.
const BULLET_FAILURE_RX =
  /^[ \t]*[●⎿✗][ \t]*(?:Please run\s+\/login|API Error:\s*401|Invalid bearer token|Invalid authentication credentials|OAuth token (?:has )?expired|Not logged in)/i

// A later success in the same transcript retires an earlier failure.
const RECOVERY_RX = /(?:Login successful|Logged in successfully|Successfully logged in|Login complete)/i

/**
 * The most recent auth failure rendered in the transcript, or null when there
 * is none or a later login already resolved it.
 */
function transcriptWedge(pane: string): ReauthState | null {
  const lines = pane.split('\n')
  let lastFail = -1
  let lastFailLine = ''
  let lastRecovery = -1
  for (let i = 0; i < lines.length; i++) {
    if (BULLET_FAILURE_RX.test(lines[i])) {
      lastFail = i
      lastFailLine = lines[i]
    }
    if (RECOVERY_RX.test(lines[i])) lastRecovery = i
  }
  if (lastFail < 0 || lastRecovery > lastFail) return null
  const marker = REAUTH_MARKERS.find((m) => !m.firstRunGate && m.rx.test(lastFailLine))
  return { needsReauth: true, reason: marker ? marker.reason : 'Auth failure in transcript' }
}

/**
 * Inspect a captured pane and decide whether the session needs re-auth.
 * Returns { needsReauth:false } for a null/empty pane (capture failed / not
 * running) -- absence of evidence is not evidence of an auth problem. Scans the
 * live status region when the pane has Claude Code's input box, else falls back
 * to the last TAIL_LINES, so scrollback that merely mentions the markers does
 * not trigger a false badge. A region that is itself a quote of a prior
 * escalation message is also excluded (see ESCALATION_QUOTE_MARKERS).
 */
export function detectReauthNeeded(pane: string | null | undefined): ReauthState {
  if (!pane) return { needsReauth: false }
  const region = liveStatusRegion(pane) ?? tailOf(pane, TAIL_LINES)
  if (ESCALATION_QUOTE_MARKERS.some((rx) => rx.test(region))) return { needsReauth: false }
  for (const m of REAUTH_MARKERS) {
    if (m.rx.test(region)) return { needsReauth: true, reason: m.reason }
  }
  // Fall back to the transcript for the "CLI thinks it is authenticated but the
  // API rejects every call" family, which never reaches the live status line.
  // The self-quote guard is re-applied across the WHOLE pane here: a quoted
  // escalation lives in the transcript, which is exactly what we are about to
  // scan.
  if (ESCALATION_QUOTE_MARKERS.some((rx) => rx.test(pane))) return { needsReauth: false }
  return transcriptWedge(pane) ?? { needsReauth: false }
}
