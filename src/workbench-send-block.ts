// The "Sending details" block at the TOP of every work item's context file (Boss, 2026-11-14): who the letter / e-mail goes to,
// the subject and the text of the covering e-mail. The agent fills it at once for every letter (court, Jobcenter, Vermieter,
// anything); the e-mail panel reads it. When there is no e-mail address the postal address and the name stay in it, so the
// block always says where the letter goes. Pure text functions (no I/O) so the file format is testable on its own.

export type Ol = (hu: string, en: string) => string

export const SEND_HEADING_HU = 'Küldési adatok (e-mail / levél)'
export const SEND_HEADING_EN = 'Sending details (e-mail / letter)'
const HEADING_RE = /^## (?:Küldési adatok|Sending details)[^\n]*$/m

export interface SendLangText { subject: string; body: string }
export interface SendDetails {
  name: string
  email: string
  postal: string
  subject: string
  body: string
  /** Language specific subject / body ("de", "en", "hu"): the language versions of a letter share ONE context file. */
  byLang: Record<string, SendLangText>
}

export const emptySendDetails = (): SendDetails => ({ name: '', email: '', postal: '', subject: '', body: '', byLang: {} })

const KEYS: Array<{ key: 'name' | 'email' | 'postal' | 'subject' | 'body'; re: RegExp }> = [
  { key: 'name', re: /^-\s*(?:címzett neve|cimzett neve|recipient name|name of the recipient)\s*:/i },
  { key: 'email', re: /^-\s*(?:címzett e-?mail(?: címe)?|cimzett e-?mail|recipient e-?mail)\s*:/i },
  { key: 'postal', re: /^-\s*(?:címzett postai címe|cimzett postai cime|recipient postal address|postal address)\s*:/i },
  { key: 'subject', re: /^-\s*(?:e-?mail tárgya|e-?mail targya|e-?mail subject)(?:\s*\(([a-z]{2})\))?\s*:/i },
  { key: 'body', re: /^-\s*(?:e-?mail szövege|e-?mail szovege|e-?mail text|e-?mail body)(?:\s*\(([a-z]{2})\))?\s*:/i },
]

/** The block's text range in a context file: from its heading to the next "## " heading (or the end). */
export function sendBlockRange(text: string): { start: number; end: number } | null {
  const m = HEADING_RE.exec(text)
  if (!m) return null
  const start = m.index
  const rest = text.slice(start + m[0].length)
  const nx = /^## /m.exec(rest)
  return { start, end: nx ? start + m[0].length + nx.index : text.length }
}

export function parseSendDetails(text: string): SendDetails | null {
  const r = sendBlockRange(text)
  if (!r) return null
  const lines = text.slice(r.start, r.end).split(/\r\n|\r|\n/).slice(1)
  const d = emptySendDetails()
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const hit = KEYS.map((k) => ({ k, m: k.re.exec(line) })).find((x) => x.m)
    if (!hit || !hit.m) { i++; continue }
    const lang = (hit.m[1] || '').toLowerCase()
    const first = line.slice(hit.m[0].length).trim()
    const parts: string[] = first ? [first] : []
    i++
    if (hit.k.key === 'body') {
      // The text runs on over the indented lines below it (blank lines inside the text stay).
      while (i < lines.length && (/^\s{2,}\S/.test(lines[i]) || (lines[i].trim() === '' && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])))) {
        parts.push(lines[i].replace(/^ {2}/, '').replace(/^\s*>\s?/, ''))
        i++
      }
    }
    const value = parts.join('\n').trim()
    if (hit.k.key === 'subject' || hit.k.key === 'body') {
      if (lang) { const cur = d.byLang[lang] ?? { subject: '', body: '' }; cur[hit.k.key] = value; d.byLang[lang] = cur } else d[hit.k.key] = value
    } else d[hit.k.key] = value
  }
  return d
}

const isPlaceholder = (v: string): boolean => /^\(.*\)$/.test(v.trim())

/** The subject / body for a letter language: its own line when there is one, else the plain line. '' when nothing is filled. */
export function sendTextFor(d: SendDetails | null, lang: string | null | undefined, key: 'subject' | 'body'): string {
  if (!d) return ''
  const own = lang ? d.byLang[lang.toLowerCase()]?.[key] : ''
  const v = (own || d[key] || '').trim()
  return isPlaceholder(v) ? '' : v
}

export function sendEmailOf(d: SendDetails | null): string {
  const v = (d?.email ?? '').trim()
  return isPlaceholder(v) ? '' : v
}

export function renderSendDetails(d: SendDetails, ol: Ol): string {
  const empty = (): string => ol('(még nincs kitöltve)', '(not filled in yet)')
  const field = (label: string, v: string): string => `- ${label}: ${v.trim() || empty()}`
  const body = (label: string, v: string): string => {
    const t = v.trim()
    if (!t) return `- ${label}: ${empty()}`
    return `- ${label}:\n` + t.split(/\r\n|\r|\n/).map((l) => (l ? `  ${l}` : '')).join('\n')
  }
  const out: string[] = [
    `## ${ol(SEND_HEADING_HU, SEND_HEADING_EN)}`,
    ol(
      '> Ide kerül a levél küldéséhez minden: a címzett, e-mail cím (ha nincs, a postai cím), a tárgy és a levél törzse. Az AI azonnal kitölti; a végleges PDF utáni e-mail-panel innen veszi.',
      '> Everything needed to send the letter: the recipient, the e-mail address (the postal address when there is none), the subject and the body. The AI fills it in at once; the e-mail panel after the final PDF reads it.',
    ),
    field(ol('Címzett neve', 'Recipient name'), d.name),
    field(ol('Címzett e-mail', 'Recipient e-mail'), d.email),
    field(ol('Címzett postai címe', 'Recipient postal address'), d.postal),
    field(ol('E-mail tárgya', 'E-mail subject'), d.subject),
    body(ol('E-mail szövege', 'E-mail text'), d.body),
  ]
  for (const lang of Object.keys(d.byLang).sort()) {
    const t = d.byLang[lang]
    const tag = lang.toUpperCase()
    if (t.subject.trim()) out.push(field(`${ol('E-mail tárgya', 'E-mail subject')} (${tag})`, t.subject))
    if (t.body.trim()) out.push(body(`${ol('E-mail szövege', 'E-mail text')} (${tag})`, t.body))
  }
  return out.join('\n') + '\n'
}

/** Puts the block text before the first "## " heading of a context file (after the intro lines), or at the end. */
function insertBlock(text: string, block: string): string {
  const m = /^## /m.exec(text)
  if (!m) return text.replace(/\s*$/, '') + '\n\n' + block
  return text.slice(0, m.index) + block + '\n' + text.slice(m.index)
}

/** A file without the block gets an empty one at the top; a file with it is returned as it is. */
export function ensureSendBlockText(text: string, ol: Ol): string {
  if (sendBlockRange(text)) return text
  return insertBlock(text, renderSendDetails(emptySendDetails(), ol))
}

export interface SendPatch { name?: string; email?: string; postal?: string; subject?: string; body?: string; lang?: string }

/** The file with the block rewritten from its parsed content plus the patch (created at the top when missing). */
export function applySendPatch(text: string, patch: SendPatch, ol: Ol): string {
  const base = ensureSendBlockText(text, ol)
  const r = sendBlockRange(base)!
  const d = parseSendDetails(base) ?? emptySendDetails()
  for (const k of ['name', 'email', 'postal'] as const) {
    const v = patch[k]
    if (typeof v === 'string' && v.trim()) d[k] = isPlaceholder(v) ? '' : v.trim()
    else if (isPlaceholder(d[k])) d[k] = ''
  }
  const lang = (patch.lang || '').toLowerCase()
  for (const k of ['subject', 'body'] as const) {
    const v = patch[k]
    if (typeof v !== 'string' || !v.trim()) continue
    if (lang) { const cur = d.byLang[lang] ?? { subject: '', body: '' }; cur[k] = v.trim(); d.byLang[lang] = cur } else d[k] = v.trim()
  }
  for (const k of ['subject', 'body'] as const) if (isPlaceholder(d[k])) d[k] = ''
  const block = renderSendDetails(d, ol)
  return base.slice(0, r.start) + block + '\n' + base.slice(r.end).replace(/^\n+/, '')
}

/** Keeps the block when a tidied text (context.rewrite) left it out. */
export function keepSendBlock(oldText: string, newText: string, ol: Ol): string {
  if (sendBlockRange(newText)) return newText
  const r = sendBlockRange(oldText)
  const block = r ? oldText.slice(r.start, r.end).replace(/\s+$/, '') + '\n' : renderSendDetails(emptySendDetails(), ol)
  return insertBlock(newText, block)
}
