/**
 * ONE rule for empty lines in a document block (#912, Boss TG 5986: "ha nyomok egy Entert, az maradjon is ott ... az ures
 * sorokat is vegye siman sornak"):
 *
 *   an empty line is a LINE. It is never trimmed away, wherever it stands in the block: above the text, inside it, below it.
 *
 * The recipient of a letter jumped up beside the sender again and again because every writer of a block's text ran `trim()`
 * on it: the empty lines above the first word were "whitespace", so they went. Each earlier repair put them back at one
 * place (#565 the page, #838 / #851 the translation); this is the rule itself, and every writer goes through it.
 *
 * Canonical form: a line holding nothing (or only spaces / zero-width spaces) is stored as ONE zero-width space (U+200B),
 * so no later `trim()` anywhere can take it for whitespace; a line with real text holds no zero-width space. The first and
 * the last line with text lose their outer spaces (as before); nothing else changes.
 *
 * The same algorithm runs in the browser (`dpCanonParts` in web/workbench.js): what the page reads is what is stored.
 */

export const BLANK_LINE_CHAR = '​'

/**
 * The canonical form of a text given in consecutive pieces (the runs of a formatted text; a plain text is one piece).
 * Returns the pieces in the same order and number, or null when no line has real text.
 */
export function canonLineParts(parts: readonly string[]): string[] | null {
  const clean = parts.map((p) => String(p ?? '').replace(/\r\n?/g, '\n').replace(/​/g, ''))
  const whole = clean.join('')
  const lines = whole.split('\n')
  const blank = lines.map((l) => l.trim() === '')
  let first = 0
  while (first < lines.length && blank[first]) first++
  if (first >= lines.length) return null
  let last = lines.length - 1
  while (blank[last]) last--
  // absolute offsets of the first real character of the first text line and the end of the last real character of the last one
  const starts: number[] = []
  let off = 0
  for (const l of lines) { starts.push(off); off += l.length + 1 }
  const firstLine = lines[first] as string
  const lastLine = lines[last] as string
  const from = (starts[first] as number) + (firstLine.length - firstLine.trimStart().length)
  const to = (starts[last] as number) + lastLine.trimEnd().length
  const out: string[] = []
  let pos = 0
  let line = 0
  let atLineStart = true
  for (const piece of clean) {
    let s = ''
    for (const ch of piece) {
      if (atLineStart) { if (blank[line]) s += BLANK_LINE_CHAR; atLineStart = false }
      if (ch === '\n') { s += ch; line++; atLineStart = true }
      else if (blank[line]) { /* the spaces of an empty line are not content */ }
      else if (line === first && pos < from) { /* outer spaces of the first text line */ }
      else if (line === last && pos >= to) { /* outer spaces of the last text line */ }
      else s += ch
      pos += ch.length
    }
    out.push(s)
  }
  // the text ended on a line break: the last line is an empty line too
  if (atLineStart && blank[line]) out[out.length - 1] += BLANK_LINE_CHAR
  return out
}

/**
 * The stored text of a block, from whatever a writer handed in. Empty lines stay (see the rule above).
 * '' when there is no text at all; one zero-width space when the writer handed in an empty line on purpose (U+200B).
 * A single line break at the very end is the end of the text, not one more line (`"abc\n"` is one line).
 */
export function blockText(raw: unknown): string {
  let s = String(raw ?? '').replace(/\r\n?/g, '\n')
  if (s.endsWith('\n')) s = s.slice(0, -1)
  const parts = canonLineParts([s])
  if (parts) return parts[0] as string
  return s.includes(BLANK_LINE_CHAR) ? BLANK_LINE_CHAR : ''
}
