/**
 * The language a document is WRITTEN in -- one rule, used by every path that builds a prompt
 * for the Workbench agent (the live chat context and the code-bridge prompt).
 *
 * Boss, Workbench chat 2026-10-18: the agent drafted a letter to a German authority in German
 * from the first line, although the owner uses Marveen in Hungarian. The cause was in the
 * prompts themselves: "write it in the language of the recipient" (the mail-draft tool) and
 * "the official register of the document's language and target court" pulled the draft towards
 * the addressee's language, and the "Answer language" line only talked about chat answers.
 *
 * The rule is NOT "always Hungarian": it follows the language switch at the bottom left of the
 * dashboard (hu / en), so an English install drafts English letters. The language of the
 * addressee, the authority, the court or the source letters never decides it. A translation is
 * a LANGUAGE VERSION made afterwards, when the owner asks.
 */
export type DocUiLang = 'hu' | 'en'

export function documentLanguageName(lang: DocUiLang): string {
  return lang === 'en' ? 'English' : 'Hungarian'
}

/** The prompt text of the rule, in the interface language `lang`. Plain text, one paragraph. */
export function documentLanguageRule(lang: DocUiLang): string {
  const name = documentLanguageName(lang)
  return `Document language: ${name}. This is the language the owner has chosen for the dashboard (the language switch at the bottom left of the screen). EVERY document text you write -- letter, e-mail, petition, note, subject line, salutation, section titles, mail-draft subject and body -- is written in ${name} from the FIRST word. The language of the addressee, of the authority, of the court, of the country of the case or of the letters among the materials does NOT change this (a letter to a German authority is drafted in ${name}; the German version is made afterwards, as a language version, when the owner asks). Word-for-word quotes from a source stay in the source's own language. The only exceptions: the owner explicitly asks in this conversation for a text in another language, or you are making a language version (doc.createVariant, doc.translateSection). Never draft in another language first "to save a step". If it is unclear which language is wanted, ask; do not guess.`
}

const VARIANT_LANG_NAMES: Record<string, string> = { hu: 'Hungarian', en: 'English', de: 'German' }

/**
 * #794 (Boss, TG 3367): a language VERSION is its own work item, and everything written for it -- the text, and the subject
 * and body of its e-mail draft -- is in the version's language, not in the dashboard language: a German PDF must not go out
 * under a Hungarian letter. This line comes after the general rule and is the exception it names ("making a language version").
 */
export function variantLanguageRule(langCode: string, sourceTitle?: string): string {
  const name = VARIANT_LANG_NAMES[langCode] ?? langCode.toUpperCase()
  return `This work item is the ${name} LANGUAGE VERSION${sourceTitle ? ` of "${sourceTitle}"` : ''}. Its document is ${name}, so EVERYTHING you write for THIS item -- text, e-mail subject and e-mail body of its mail draft (doc.mailDraft), salutation, closing -- is in ${name}, whatever the dashboard language is. The attached PDF and the letter that carries it are always in the same language.`
}
