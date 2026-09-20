/**
 * The verification finding an approval description carries.
 *
 * Kanban a2d2470e (#334): the finding used to be spliced in by replacing the
 * auto-generated "...meg nincs benne, mi lett tesztelve..." marker, so it could
 * only ever be written ONCE. A second report -- the common fail -> pass
 * sequence -- found no marker any more and silently left the FIRST, stale
 * finding standing, which is what the owner then decided on. Real case
 * 2026-09-19: card #321 (c17e3a2d) reported fail, then pass, and the
 * description still ended with the old "Javaslat: ... varjon" line.
 *
 * The rule now: the description always carries the LATEST finding. This module
 * is the single place that knows how that block is written and recognised, so
 * the writer and the test measure the same thing.
 */

/** Auto-generated tail of a description raised by a card entering `waiting`
 * (see `ensureApprovalForWaitingCard`). Exported so the generator and the
 * replacement never drift apart. */
export const AUTO_TESTING_MARKER =
  'Ezt a kérést a kártya mozgatása hozta létre automatikusan, ezért még nincs benne, mi lett tesztelve: '

/** Start of the CURRENT finding block. Distinctive on purpose: an agent writing
 * its own description does not type this exact phrase, so cutting here cannot
 * eat the description itself. */
export const FINDING_BLOCK_START = 'Tesztelve (legfrissebb): '

/** Start of the format written BEFORE #334 ("Tesztelve: <icon> ..."), appended
 * in place of the marker. Live approval rows still carry it, so the cut has to
 * recognise it too. The icon is required: it is what the mechanism emits, and
 * it keeps a human sentence like "Tesztelve: teljes suite zold" from matching. */
const LEGACY_FINDING_RE = /\s*Tesztelve: (?:✅|❌) /

export type VerificationStatus = 'pass' | 'fail'

/** `<icon> <agent> -- <report>`, the finding itself without its block start. */
export function verificationFindingText(
  agent: string, status: VerificationStatus, report: string | null,
): string {
  const icon = status === 'pass' ? '✅' : '❌'
  const text = (report ?? '').trim() || '(nincs indoklás)'
  return `${icon} ${agent.trim()} -- ${text}`
}

/**
 * The description text WITHOUT any finding block: what the finding was (or will
 * be) appended to. Recognises, in this order, the current block start, the
 * auto-generated marker, and the pre-#334 block.
 */
export function descriptionWithoutFinding(desc: string | null): string {
  const text = desc ?? ''
  // First occurrence, never the last: the base text carries none of these, so
  // the first match is where OUR block begins -- a report that happens to quote
  // one of them sits inside the block and must not move the cut.
  const current = text.indexOf(FINDING_BLOCK_START)
  if (current >= 0) return text.slice(0, current).trimEnd()
  const marker = text.indexOf(AUTO_TESTING_MARKER)
  if (marker >= 0) return text.slice(0, marker).trimEnd()
  const legacy = LEGACY_FINDING_RE.exec(text)
  if (legacy) return text.slice(0, legacy.index).trimEnd()
  return text.trimEnd()
}

/**
 * The description to store after `agent` reported `status`. Replaces an earlier
 * finding instead of stacking on it, and appends one even when the description
 * carries no marker at all (an agent-written description used to get no finding
 * whatsoever).
 */
export function applyVerificationFinding(
  desc: string | null, agent: string, status: VerificationStatus, report: string | null,
): string {
  const base = descriptionWithoutFinding(desc)
  const block = `${FINDING_BLOCK_START}${verificationFindingText(agent, status, report)}`
  return base ? `${base}\n\n${block}` : block
}
