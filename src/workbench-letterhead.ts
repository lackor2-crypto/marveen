/**
 * Boss (TG, 2026-11-02): a letter to a court or an authority needs a letter head -- the SENDER and the RECIPIENT written out
 * and framed, with the labels ("Feladó" / "Címzett", "Absender" / "Empfänger"). A court once did not take a filing because
 * nobody had written down who the sender and the recipient were. The frame is the table block (it is drawn with a thin
 * border in the PDF); this module is the WATCH: a document that reads like a letter but carries no labelled sender and
 * recipient gets a to-do (never a gate on finalizing -- the owner decides).
 */
import { fold } from './workbench-doccheck.js'

interface HeadBlock { kind: string; text: string }

/** A salutation line = the text is a letter (a plain note or a table sheet has none). */
const SALUTATION_RE = /^(sehr geehrte|geehrte|tisztelt|kedves|dear)\b/
/** A labelled sender / recipient: the label and a colon, in any of the languages the owner writes in. */
const SENDER_RE = /(?:^|[\s|])(felado|absender|sender)\s*:/m
const RECIPIENT_RE = /(?:^|[\s|])(cimzett|empfanger|empfaenger|recipient|addressee)\s*:/m

export function looksLikeLetter(blocks: HeadBlock[]): boolean {
  return blocks.some((b) => b.kind === 'signature' || (b.kind === 'paragraph' && SALUTATION_RE.test(fold(b.text).trim())))
}

/** True when the letter has its sender and recipient labelled (in one framed table, or in lines of text). */
export function hasLetterHead(blocks: HeadBlock[]): boolean {
  const text = blocks.filter((b) => b.kind === 'table' || b.kind === 'paragraph').map((b) => fold(b.text)).join('\n')
  return SENDER_RE.test(text) && RECIPIENT_RE.test(text)
}

/** 1 = a letter without a labelled sender / recipient (the check row's count); 0 = fine, or not a letter. */
export function letterHeadMissing(blocks: HeadBlock[]): number {
  return looksLikeLetter(blocks) && !hasLetterHead(blocks) ? 1 : 0
}

// --- Window-envelope layout (Boss TG 4543, 2026-11-03) ---------------------------------------------------------------
// The owner tuned this form by hand on a real letter and asked that it be the form of EVERY official letter: the SENDER is a
// framed table block placed at the top right (`#w=45&a=l&x=55&y=0&o=1`: 45 % wide, 55 % from the left, over the text, takes no
// room), the RECIPIENT is the first paragraph on the left, pushed down with empty (zero-width-space) lines so that it lands in
// the window of a window envelope. Then place + date, the reference line, the salutation.
const ZWSP = '​'
export const LETTER_HEAD_LABELS: Record<string, { sender: string; recipient: string }> = {
  hu: { sender: 'Feladó', recipient: 'Címzett' },
  de: { sender: 'Absender', recipient: 'Empfänger' },
  en: { sender: 'Sender', recipient: 'Recipient' },
}
/** Blank lines above / below the recipient block (the owner's own setting on the sample letter). */
export const LETTER_HEAD_LINES_ABOVE = 4
export const LETTER_HEAD_LINES_BELOW = 2
/** The sender table's size / place tail: the owner's own setting. */
export const LETTER_HEAD_SENDER_TAIL = '#w=45&a=l&x=55&y=0&o=1'

/** The two blocks that open an official letter, in this order: the sender table (kind "table") then the recipient (kind "paragraph"). */
export function buildLetterHead(lang: string, sender: string[], recipient: string[]): { table: string; paragraph: string } {
  const lab = LETTER_HEAD_LABELS[lang] || LETTER_HEAD_LABELS.hu!
  const table = [lab.sender + ':', ...sender, LETTER_HEAD_SENDER_TAIL].join('\n')
  const blank = (n: number): string[] => Array.from({ length: n }, () => ZWSP)
  const paragraph = [...blank(LETTER_HEAD_LINES_ABOVE), lab.recipient + ':', ...recipient, ...blank(LETTER_HEAD_LINES_BELOW)].join('\n')
  return { table, paragraph }
}

export { LETTER_LAYOUT_RULES_EN } from './letter-layout-rules.js'

/** Minimum number of blank (U+200B-only or empty) lines between two consecutive pieces of a letter that must stand apart. */
const BLANK_LINE_RE = /^[\s​]*$/

/** Splits a block's text into its lines; blank = empty or U+200B-only. */
function lines(text: string): string[] { return text.split('\n') }

/**
 * 1 = a letter whose subject, reference lines, salutation or closing are glued to the neighbouring text: the line before or
 * after has real content and nothing (no blank line, no block boundary holding a blank line) separates them. 0 = fine / not a letter.
 * Looks at the flat sequence of lines of all paragraph blocks; a block boundary alone does NOT count as a gap (the paragraph
 * margin is small), only an explicit blank line does.
 */
export function letterSpacingMissing(blocks: HeadBlock[]): number {
  const salutLine = (l: string): boolean => SALUTATION_RE.test(fold(l).trim())
  const isLetter = looksLikeLetter(blocks) || blocks.some((b) => b.kind === 'paragraph' && lines(b.text).some(salutLine))
  if (!isLetter) return 0
  const flat: string[] = []
  for (const b of blocks) {
    if (b.kind !== 'paragraph') { flat.push(ZWSP); continue }
    for (const l of lines(b.text)) flat.push(l)
    flat.push('\u0001') // block boundary marker (not a gap)
  }
  const seq = flat.filter((l) => l !== '\u0001')
  const blank = (l: string | undefined): boolean => l === undefined || BLANK_LINE_RE.test(l)
  const subject = /^(targy|betreff|subject)\b\s*:/
  const salut = /^(sehr geehrte|geehrte|tisztelt|kedves|dear)\b/
  for (let i = 0; i < seq.length; i++) {
    const f = fold(seq[i]!).trim()
    if (!f) continue
    if (subject.test(f) || salut.test(f)) {
      // glued to a non-blank line before, or (salutation / subject block) directly followed by text
      if (!blank(seq[i - 1]) && i > 0) return 1
      if (salut.test(f) && !blank(seq[i + 1]) && i + 1 < seq.length) return 1
    }
  }
  return 0
}

// --- Recipient window position (Boss TG 4597, 2026-11-03) --------------------------------------------------------------
// The recipient block must sit LOWER on the page, in the window of a window envelope (4 blank lines above it). The
// assistant sometimes wrote plain newlines, which the model strips (`trim()`), so the recipient started at the top, beside the
// sender. The system itself puts the position right: an agent-written paragraph that starts with the recipient label gets the
// blank (U+200B) lines in front of it. Never touches a block the owner wrote.
const RECIPIENT_FIRST_RE = /^(cimzett|empfanger|empfaenger|recipient|addressee)\s*:/

/** Text of a recipient paragraph with its LETTER_HEAD_LINES_ABOVE blank lines restored; any other text comes back unchanged. */
export function enforceRecipientWindow(text: string): string {
  const ls = text.split('\n')
  let i = 0
  while (i < ls.length && BLANK_LINE_RE.test(ls[i]!)) i++
  if (i >= ls.length || !RECIPIENT_FIRST_RE.test(fold(ls[i]!).trim())) return text
  if (i >= LETTER_HEAD_LINES_ABOVE) return text
  return [...Array.from({ length: LETTER_HEAD_LINES_ABOVE }, () => ZWSP), ...ls.slice(i)].join('\n')
}

/**
 * The recipient block of a TRANSLATED letter keeps the window position of the original, to the line (Boss TG 4734, 2026-11-03):
 * when the source paragraph is a recipient block (blank lines, then the "Címzett:" label), the translation gets exactly the
 * source's leading and trailing blank (U+200B) lines, whatever the model wrote or stripped. Any other text comes back unchanged.
 */
export function mirrorRecipientWindow(source: string, translated: string): string {
  const sl = source.split('\n')
  let lead = 0
  while (lead < sl.length && BLANK_LINE_RE.test(sl[lead]!)) lead++
  if (lead >= sl.length || !RECIPIENT_FIRST_RE.test(fold(sl[lead]!).trim())) return translated
  let trail = 0
  while (trail < sl.length - lead - 1 && BLANK_LINE_RE.test(sl[sl.length - 1 - trail]!)) trail++
  const tl = translated.split('\n')
  let a = 0
  while (a < tl.length && BLANK_LINE_RE.test(tl[a]!)) a++
  let b = 0
  while (b < tl.length - a && BLANK_LINE_RE.test(tl[tl.length - 1 - b]!)) b++
  const core = tl.slice(a, tl.length - b)
  if (!core.length) return translated
  const blank = (n: number): string[] => Array.from({ length: n }, () => ZWSP)
  return [...blank(lead), ...core, ...blank(trail)].join('\n')
}
