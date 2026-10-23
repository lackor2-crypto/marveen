// A card whose landed work touches the screen (web/) must not go to waiting without a real-browser click-through
// (Boss TG 10143, 10150: "at least 4-5 times every agent skipped it"). The rule stood in text only; this is the gate.
//
//  - UI work is read from git: a commit on main/HEAD that names the card (`#N` anywhere except the trailing `(#PR)` the
//    squash merge appends) or whose PR number a card comment names, and that changes a file under web/.
//  - Evidence is a card comment that says the click-through was done (markers below). The clicking itself is the agent's
//    job; the gate only refuses to let the card move without its trace.
//  - A person dragging the card in a password session is not asked (same as the all-points-done gate). A card that is
//    server-only (no web/ file in its commits) is never held. Anything the gate cannot measure lets the move through.
//  - `ui_clickthrough_skip_reason` (15+ chars) is the explicit, recorded way out ("the change has no screen effect").
//
// Pure decision in checkClickthroughMove, git reading in cardTouchesWebUi.
import { execFileSync } from 'node:child_process'

export const CLICKTHROUGH_MARKER = /v[eé]gigkattint|click[\s-]?through|b[öo]ng[ée]sz[öo]s\s+(pr[óo]ba|ellen[őo]rz)/i
export const SKIP_REASON_MIN = 15

export interface ClickthroughInput {
  prevStatus: string | undefined
  newStatus: string | undefined
  agentCaller: boolean
  /** True when a commit of the card changed a web/ file; null when it could not be measured. */
  uiTouched: boolean | null
  commentTexts: ReadonlyArray<string>
  skipReason: unknown
}

export interface ClickthroughRefusal { error: 'ui_clickthrough_missing'; message: string }

export function hasClickthroughEvidence(commentTexts: ReadonlyArray<string>): boolean {
  return commentTexts.some((t) => CLICKTHROUGH_MARKER.test(t))
}

export function checkClickthroughMove(i: ClickthroughInput): ClickthroughRefusal | null {
  if (i.newStatus !== 'waiting' || i.prevStatus === 'waiting' || !i.agentCaller) return null
  if (i.uiTouched !== true) return null
  if (hasClickthroughEvidence(i.commentTexts)) return null
  if (typeof i.skipReason === 'string' && i.skipReason.trim().length >= SKIP_REASON_MIN) return null
  return {
    error: 'ui_clickthrough_missing',
    message: 'A kártya landolt munkája a felületet (web/) érinti, de nincs rajta böngészős végigkattintás nyoma. Csináld meg külön, üres web-only példányon, valódi böngészőben (Playwright), és írd kommentben a kártyára: mit kattintottál, mit mértél, mit NEM próbáltál (a komment tartalmazza a "végigkattintás" szót). Ha a változásnak nincs felületi hatása, küldd újra "ui_clickthrough_skip_reason": "<legalább 15 karakter indok>" mezővel. / The card\'s landed work touches the UI (web/) but no real-browser click-through is recorded. Do it on a separate empty web-only instance, then comment it on the card (what you clicked, measured, did NOT try; the comment must contain "click-through"/"végigkattintás"). If the change has no screen effect, resend with "ui_clickthrough_skip_reason" (15+ characters).',
  }
}

/** PR numbers a card comment names ("PR #1387", ".../pull/1387"). */
export function prNumbersFromComments(commentTexts: ReadonlyArray<string>): Set<number> {
  const out = new Set<number>()
  for (const t of commentTexts) {
    for (const m of t.matchAll(/(?:\bPR\s*#?|\/pull\/)(\d{1,6})\b/gi)) out.add(Number(m[1]))
  }
  return out
}

interface LogCommit { subject: string; files: string[] }

export function parseGitLog(raw: string): LogCommit[] {
  const out: LogCommit[] = []
  for (const block of raw.split('@@COMMIT@@').slice(1)) {
    const lines = block.split('\n')
    out.push({ subject: (lines[0] || '').trim(), files: lines.slice(1).map((l) => l.trim()).filter(Boolean) })
  }
  return out
}

/** Does any commit of this card (by number or by the PR numbers its comments name) change a web/ file? */
export function uiTouchedByCard(commits: ReadonlyArray<LogCommit>, seq: number, prNumbers: ReadonlySet<number>): boolean {
  const cardRef = new RegExp(`#${seq}(?!\\d)`)
  for (const c of commits) {
    const pr = c.subject.match(/\(#(\d+)\)\s*$/)
    const body = pr ? c.subject.slice(0, pr.index) : c.subject
    const mine = cardRef.test(body) || (pr != null && prNumbers.has(Number(pr[1])))
    if (mine && c.files.some((f) => f.startsWith('web/'))) return true
  }
  return false
}

/** Reads the history of the checkout at `root`. null = could not be measured (no git, no history), never a fake false. */
export function cardTouchesWebUi(root: string, seq: number, commentTexts: ReadonlyArray<string>): boolean | null {
  try {
    const raw = execFileSync('git', ['-C', root, 'log', '-n', '4000', '--format=@@COMMIT@@%s', '--name-only', 'HEAD', 'origin/main'],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const commits = parseGitLog(raw)
    if (!commits.length) return null
    return uiTouchedByCard(commits, seq, prNumbersFromComments(commentTexts))
  } catch { return null }
}
