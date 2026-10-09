/**
 * Inline formatting of a document block (bold, italic, underline, strike) and its alignment.
 *
 * The block's `text` stays the plain text every other part of the system works on (claims,
 * checks, translation, search). The formatting rides next to it as `rich`, a tiny HTML subset
 * (<b> <i> <u> <s> <br>), and `align`. `rich` is only trusted while its plain text equals the
 * block's `text`: when something else rewrites the text (an agent, a label renumbering), the
 * formatting is simply ignored instead of being painted on the wrong words.
 */

export const BLOCK_ALIGNS = ['l', 'c', 'r', 'j'] as const
export type BlockAlign = (typeof BLOCK_ALIGNS)[number]

export function isBlockAlign(v: unknown): v is BlockAlign {
  return typeof v === 'string' && (BLOCK_ALIGNS as readonly string[]).includes(v)
}

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

function decode(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m] ?? m)
}

function encode(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface RichRun { text: string; b: boolean; i: boolean; u: boolean; s: boolean }

const TAG_RE = /<(\/?)(b|strong|i|em|u|s|strike|del|br)\s*\/?>|<[^>]*>/gi
const CANON: Record<string, 'b' | 'i' | 'u' | 's' | 'br'> = {
  b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', br: 'br',
}

/** The runs of a rich string: consecutive characters sharing one set of marks. Unknown tags are dropped. */
export function richRuns(input: string): RichRun[] {
  const runs: RichRun[] = []
  const on = { b: 0, i: 0, u: 0, s: 0 }
  let last = 0
  const push = (raw: string): void => {
    const text = decode(raw)
    if (!text) return
    const r: RichRun = { text, b: on.b > 0, i: on.i > 0, u: on.u > 0, s: on.s > 0 }
    const p = runs[runs.length - 1]
    if (p && p.b === r.b && p.i === r.i && p.u === r.u && p.s === r.s) p.text += text
    else runs.push(r)
  }
  const src = String(input ?? '')
  for (const m of src.matchAll(TAG_RE)) {
    push(src.slice(last, m.index ?? 0))
    last = (m.index ?? 0) + m[0].length
    const name = m[2] ? CANON[m[2].toLowerCase()] : undefined
    if (!name) continue
    if (name === 'br') { push('\n'); continue }
    const closing = m[1] === '/'
    on[name] = Math.max(0, on[name] + (closing ? -1 : 1))
  }
  push(src.slice(last))
  return runs
}

/** The plain text of a rich string (what the block's `text` must equal). */
export function richToPlain(input: string): string {
  return richRuns(input).map((r) => r.text).join('')
}

/** Canonical rich string: only <b><i><u><s> and <br>, properly nested; '' when there is no formatting at all. */
export function sanitizeRich(input: unknown): string {
  const runs = richRuns(String(input ?? ''))
  if (!runs.some((r) => r.b || r.i || r.u || r.s)) return ''
  return runs.map((r) => {
    let out = encode(r.text).replace(/\n/g, '<br>')
    if (r.s) out = `<s>${out}</s>`
    if (r.u) out = `<u>${out}</u>`
    if (r.i) out = `<i>${out}</i>`
    if (r.b) out = `<b>${out}</b>`
    return out
  }).join('')
}

/** Does this rich string describe exactly this plain text? */
export function richMatches(rich: string | null | undefined, text: string): boolean {
  if (!rich) return false
  return richToPlain(rich).replace(/\r\n/g, '\n').trim() === String(text ?? '').replace(/\r\n/g, '\n').trim()
}
