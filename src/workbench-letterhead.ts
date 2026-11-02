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
