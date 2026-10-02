/**
 * BELEPO: "MIT SZERETNEL LETREHOZNI?" (kanban #441, v4 spec 9, K-3.1).
 *
 * Egy mondatbol (vagy egy gombbol) munkadarab. A munkatipust itt egy
 * szotar-alapu osztalyozo talalja ki -- ingyen, azonnal, halozat nelkul, es
 * tesztelhetoen. A spec kikotese: ha nem biztos, VISSZAKERDEZ. Ezert a
 * valasz harom fele lehet: egyertelmu tipus, ketto kozott habozik (a
 * felulet a kettot kinalja), vagy semmi (a felulet mind az otot kinalja).
 * Nem talalgatunk: egy rosszul megnyitott felulet rosszabb, mint egy kerdes.
 */

export const INTAKE_KINDS = ['social_post', 'document', 'court_filing', 'video', 'presentation'] as const
export type IntakeKind = typeof INTAKE_KINDS[number]
/** A jegyzet (md / txt fajl) NEM gomb: csak a mondatbol ismerjuk fel ("csinalj egy md filet"). */
export type IntakeKindAny = IntakeKind | 'note'

/** Melyik munkadarab-fajta nyilik (K-3.3: a munkatipus szerinti felulet). A
 *  prezentacio sajat munkadarab-fajta (5. fazis): diasor, minden dia egy vaszon. */
export const INTAKE_TYPE: Record<IntakeKind, string> = {
  social_post: 'graphic',
  document: 'document',
  court_filing: 'document',
  video: 'video',
  presentation: 'presentation',
}

/** A jegyzet-szavak: egy sima szovegfajl a kero szavaval ("md fajl", "jegyzet", "txt"). */
const NOTE_WORDS = ['md', 'markdown', 'jegyzet', 'txt', 'szovegfajl', 'szoveges fajl', 'text file', 'textfile', 'note ', 'notes', 'notiz']

// Szotovek (kisbetu, ekezet nelkul). Magyar, angol, nemet -- a Munkapad harom nyelve.
const WORDS: Record<IntakeKind, string[]> = {
  court_filing: [
    'birosag', 'beadvany', 'kereset', 'fellebbez', 'vegzes', 'itelet', 'ugyved', 'perben', 'peres', 'perrol', 'perem', 'perunk', 'perhez', 'targyalas', 'ellenkerelem',
    'vegrehajt', 'hatarozat', 'birosagi', 'fizetesi meghagyas', 'court', 'filing', 'lawsuit', 'complaint', 'motion', 'appeal',
    'judge', 'gericht', 'klage', 'schriftsatz', 'berufung', 'anwalt', 'beschluss', 'urteil',
  ],
  social_post: [
    'poszt', 'facebook', 'instagram', 'insta', 'story', 'reel', 'tiktok', 'linkedin', 'kozossegi', 'hirdetes', 'plakat',
    'banner', 'social', 'post', 'beitrag', 'werbung', 'flyer', 'szorolap',
  ],
  video: ['video', 'film', 'vagas', 'klip', 'youtube', 'felvetel', 'clip', 'footage', 'schnitt'],
  presentation: ['prezentacio', 'diasor', 'dia ', 'diak', 'eloadas', 'powerpoint', 'pptx', 'slide', 'presentation', 'deck', 'prasentation', 'vortrag', 'folien'],
  document: [
    'level', 'ajanlat', 'szerzodes', 'jelentes', 'dokumentum', 'meghivo', 'email', 'e-mail', 'jegyzokonyv', 'kerelem', 'nyilatkozat',
    'letter', 'offer', 'contract', 'report', 'document', 'invitation', 'memo', 'brief', 'vertrag', 'angebot', 'bericht', 'einladung',
  ],
}

function fold(s: string): string {
  return ` ${String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
}

export type IntakeGuess =
  | { sure: true; kind: IntakeKindAny }
  | { sure: false; options: IntakeKind[] }

/** A mondat munkatipusa. Biztos, ha EGY tipus kap a legtobb talalatot, es
 *  a beadvany-szavak nem keverednek mas tipussal (egy "birosagi poszt" kerdes). */
export function guessIntakeKind(text: unknown): IntakeGuess {
  const t = fold(String(text ?? ''))
  const score: Record<string, number> = {}
  for (const k of INTAKE_KINDS) {
    // Szoeleji egyezes (szoto): " birosag" talal a "birosagnak"-ra is.
    score[k] = WORDS[k].filter((w) => t.includes(` ${w}`)).length
  }
  // Egy md / jegyzet kerese: sima szovegfajl munkadarab (a beadvany-szavak ezt nem zavarjak meg).
  if (NOTE_WORDS.some((w) => t.includes(` ${w}`)) && !score['court_filing']) return { sure: true, kind: 'note' }
  const ranked = [...INTAKE_KINDS].filter((k) => (score[k] ?? 0) > 0).sort((a, b) => (score[b] ?? 0) - (score[a] ?? 0))
  if (!ranked.length) return { sure: false, options: [...INTAKE_KINDS] }
  const top = ranked[0] as IntakeKind
  const second = ranked[1]
  // Holtverseny: a ketto kozul a tulajdonos valaszt.
  if (second && score[second] === score[top]) return { sure: false, options: ranked.filter((k) => score[k] === score[top]) as IntakeKind[] }
  // A beadvany kulon sulyu: ha mas tipus is szoba jon, rakerdezunk (a
  // "level a birosagnak" lehet beadvany vagy sima level, a "poszt a perrol"
  // lehet poszt vagy a perhez tartozo irat -- a tulajdonos donti el).
  if (second && (top === 'court_filing' || second === 'court_filing')) return { sure: false, options: [top, second as IntakeKind] }
  return { sure: true, kind: top }
}

/** A munkadarab cime a mondatbol: az elso mondat, rovidre vagva. Ures mondatnal
 *  a tipus neve (a felulet nyelven). */
export function intakeTitle(text: unknown, kind: IntakeKindAny, lang: 'hu' | 'en'): string {
  // A jegyzet fajlnev is lesz: a hosszu kero mondat nem jo nev, ezert fix, rovid cim.
  if (kind === 'note') return lang === 'en' ? 'New note' : 'Új jegyzet'
  const first = String(text ?? '').trim().split(/(?<=[.!?])\s+|\n/)[0]?.trim() || ''
  if (first) return first.length > 80 ? first.slice(0, 77).replace(/\s+\S*$/, '') + '…' : first
  const names: Record<IntakeKind, { hu: string; en: string }> = {
    social_post: { hu: 'Új közösségi poszt', en: 'New social post' },
    document: { hu: 'Új dokumentum', en: 'New document' },
    court_filing: { hu: 'Új bírósági beadvány', en: 'New court filing' },
    video: { hu: 'Új videó', en: 'New video' },
    presentation: { hu: 'Új prezentáció', en: 'New presentation' },
  }
  return names[kind][lang]
}
