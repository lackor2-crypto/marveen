// What a letter says about itself: the language its TEXT is written in and its own subject line.
// #794 (Boss TG 3435/3441/3445): the work item's title is what the owner typed in HIS language ("Egy levelet akarok irni a
// Berlini Rendorsegnek") and must never reach the recipient -- not in the subject, not in the text, not in a file name.
// Everything that leaves the house is named from the letter itself, in the letter's language.
import { hasDocModel, listBlocks } from './workbench-docmodel.js'

export type LetterLang = 'hu' | 'en' | 'de'

// Whole-word markers of each language; the language of the TEXT is the one with the most hits.
const LANG_WORDS: Record<LetterLang, RegExp> = {
  de: /\b(der|die|das|und|nicht|ich|sie|bitte|mit|für|von|zu|ist|ein|eine|auf|dem|den|bezüglich|sehr|geehrte)\b/gi,
  hu: /\b(és|hogy|nem|egy|az|vagy|van|meg|kérem|tisztelt|szeretném|mert|volt|ezt)\b/gi,
  en: /\b(the|and|of|to|is|for|with|that|this|please|dear|was|are|have)\b/gi,
}

/** The language a text is written in, null when it cannot be told (too little text). */
export function detectTextLanguage(textIn: string): LetterLang | null {
  const text = textIn.slice(0, 6000)
  const score = (l: LetterLang): number => (text.match(LANG_WORDS[l]) || []).length
  const ranked = (['de', 'hu', 'en'] as LetterLang[]).map((l) => [l, score(l)] as const).sort((a, b) => b[1] - a[1])
  return ranked[0][1] >= 3 && ranked[0][1] > ranked[1][1] ? ranked[0][0] : null
}

/** Subject of a letter from its lines: a labelled line (Betreff / Subject / Tárgy / Re), else the line after the date line. */
export function subjectFromLines(linesIn: string[]): string {
  const lines = linesIn.map((l) => String(l ?? '').replace(/[​\s]+/g, ' ').trim()).filter(Boolean)
  for (const l of lines) {
    const m = /^(?:betreff|betr\.?|subject|re|tárgy|targy)\s*[:.]\s*(.{3,250})$/i.exec(l)
    if (m) return m[1].trim()
  }
  const di = lines.findIndex((l) => l.length <= 60 && /\b\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(l))
  const next = di >= 0 ? lines[di + 1] : undefined
  if (next && next.length >= 6 && next.length <= 250 && !/[,:]$/.test(next) && !/^(sehr geehrte|dear|tisztelt)/i.test(next)) return next
  return ''
}

/** The subject line of a document-model letter, '' when it has none (the title is NEVER a substitute). */
export function letterSubject(itemId: string): string {
  try {
    if (!hasDocModel(itemId)) return ''
    return subjectFromLines(listBlocks(itemId).map((b) => String(b.text ?? '')))
  } catch { return '' }
}

/** The language of a document-model letter's text, null when unknown. */
export function letterLanguage(itemId: string): LetterLang | null {
  try {
    if (!hasDocModel(itemId)) return null
    return detectTextLanguage(listBlocks(itemId).map((b) => b.text).join(' '))
  } catch { return null }
}

/** The words a nameless letter is called in a file name, in the letter's language. */
export const NAMELESS_LETTER: Record<LetterLang, string> = { de: 'Schreiben', en: 'Letter', hu: 'Levél' }
