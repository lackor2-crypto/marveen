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
