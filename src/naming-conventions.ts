// NEVADASI ES IKON-KONVENCIOK -- EGY HELYEN.
//
// Honnan jott (kanban #167 / 9588db41). Botond Peter, 2026-08-24:
//
//   "Normal esetben a gep is a slugos konvenciora torekszik. De szokozt sose
//    hasznalj konyvtarnevekben. Meg speci karaktert. [...] Nekem rengeteg ilyen
//    sajat konvencionalis szabaly be van mar teve a honapok alatt. Mit hogy kell
//    elnevezni, ha ikon kell hozza melyik ikon, stb. Aztan ha valami ujat
//    csinal, akkor azok alapjan hozza letre."
//
// A lenyeg az utolso mondat: legyen egy hely, amit LETREHOZAS ELOTT el lehet
// olvasni, es ami megmondja, hogy nevezd es milyen ikont kapjon. Ez az a hely.
//
// KET ZONA VAN, es ez nem stilus-kerdes, hanem a kar termeszete:
//
//   EMBER-ZONA (az eletfa java resze). Ekezet es szokoz RENDBEN -- sot,
//   kotelezo: az eletfa embernek szol, es a mappa neve a felulet nyelvet koveti
//   (`<gyoker>/<Nev>/Projektek/Tozsde/Fejlesztes`). Ha ezt slugositanank,
//   elveszne az ertelme. Itt csak azokra a jelekre figyelmeztetunk, amik a
//   PARANCSSORT torik el akkor is, ha ember olvassa a nevet.
//
//   GEP-ZONA (`GIT_REPOS` es minden alatta). Itt a nevet a git es a parancssor
//   hasznalja. A `GIT_REPOS` neve maga sincs leforditva (life-tree.ts: "a
//   nevuket a GitHub adja, es a fejlesztonek ugyanugy kell kineznie minden
//   gepen") -- ez a fa mar meglevo gep-zonaja, nem uj talalmany. Itt slug jar:
//   kisbetu, kotojel, ekezet es szokoz nelkul.
//
// AMIT BOTOND ALABECSUL: azt irja, "ekezet lenyegeben nem baj". A sajat
// meresunk ennek ellentmond -- az MT4 koltozesnel a `.bat` fajlnak ekezet
// nelkuli utat kellett adni, mert a `cmd.exe` OEM kodlapja NEMAN verte szet az
// ekezetet: nem hibauzenetet adott, hanem rossz utat. A nemasag a rossz benne.
// Ezert a gep-zonaban az ekezet nem "nem szokas", hanem figyelmeztetendo.
//
// EZ A MODUL NEM TILT. Figyelmeztet, es MEGMONDJA a kovetkezo lepest (a
// javasolt nevet). Egy vak tiltas ott is megallitana a felhasznalot, ahol
// tenyleg egy szokozos nevet akar -- es a sajat fajaban ehhez joga van.
import { APP_LANG } from './config.js'
import { lifeKeyForName, lifeNameKeys } from './life-tree.js'

/** A gep-zona jelolo mappaja. Ugyanaz a nev, amit a fa hasznal (`gitRepos`). */
export const MACHINE_ZONE_DIR = 'GIT_REPOS'

export type NamingZone = 'human' | 'machine'

/**
 * Melyik zonaba esik egy fan beluli relativ ut.
 *
 * A `GIT_REPOS` MAGA is gep-zona, nem csak ami alatta van: a mappat a git
 * kezeli, es a testverei kozott is gepi nev.
 */
export function namingZone(rel: string): NamingZone {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean)
  return parts.includes(MACHINE_ZONE_DIR) ? 'machine' : 'human'
}

/**
 * Gepi nev egy ember-nevbol: kisbetu, ekezet nelkul, kotojellel.
 *
 * Az ekezet-bontas `NFD`-vel megy es a kombinalo jeleket dobja -- igy az `o`
 * `o` lesz, nem `_`. Ami ezutan sem betu vagy szam, az kotojel.
 */
export function slugify(name: string): string {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A PARANCSSORT torő jelek, amik az ember-zonaban is bajt csinalnak.
 *
 * Nem a teljes tiltolista: a `safeLifeName()` a Windows tiltott jeleit (`<>:"|?*`
 * es a per-jelet) mar kiszedi. Ami MEGMARAD es megis rossz: a shell sajat
 * jelei, es a vezeto kotojel (amit minden parancs kapcsolonak nez).
 */
const SHELL_HAZARD_RE = /[$`;&!#()'"\][{}*?~]/

/** Egy figyelmeztetes: mi a baj, es MI LEGYEN HELYETTE. */
export interface NameAdvice {
  /** true, ha nincs mit szolni. */
  ok: boolean
  zone: NamingZone
  /** A javasolt nev, ha van jobb. Ures, ha a nev rendben van. */
  suggestion: string
  /** Ember-mondat a felulet nyelven. Ures, ha `ok`. */
  message: string
  /** Gepi ok-kod: `machine_zone_not_slug` | `shell_hazard` | `leading_dash` | ''. */
  code: string
}

function T(lang: string, hu: string, en: string): string {
  return lang === 'en' ? en : hu
}

/**
 * Megnezi egy SZANDEKOLT nevet a zonaja szabalyai szerint.
 *
 * Nem nyul semmihez es nem tilt: a hivo dolga eldonteni, hogy figyelmeztet-e
 * vagy tovabbenged. A `suggestion` mindig hasznalhato nev (vagy ures).
 */
export function checkName(name: string, zone: NamingZone, lang: string = APP_LANG): NameAdvice {
  const raw = String(name || '')
  const ok: NameAdvice = { ok: true, zone, suggestion: '', message: '', code: '' }
  if (!raw.trim()) return ok

  if (zone === 'machine') {
    const slug = slugify(raw)
    if (!slug) {
      return {
        ok: false, zone, suggestion: '', code: 'machine_zone_not_slug',
        message: T(lang,
          `A ${MACHINE_ZONE_DIR} alatt a nevet a git és a parancssor is használja, ezért csak angol kisbetű, szám és kötőjel lehet benne. Ebből a névből nem tudok ilyet készíteni -- adj meg egy másikat.`,
          `Under ${MACHINE_ZONE_DIR} the name is used by git and the command line, so it may only contain lower-case latin letters, digits and hyphens. I cannot build one from this name -- please give another.`),
      }
    }
    if (slug !== raw) {
      return {
        ok: false, zone, suggestion: slug, code: 'machine_zone_not_slug',
        message: T(lang,
          `A ${MACHINE_ZONE_DIR} alatt a nevet a git és a parancssor is használja: az ékezet és a szóköz ott némán rossz útvonalat csinál (nem hibaüzenetet). Javasolt név: ${slug}`,
          `Under ${MACHINE_ZONE_DIR} the name is used by git and the command line, where accents and spaces silently produce a wrong path (not an error). Suggested name: ${slug}`),
      }
    }
    return ok
  }

  // Ember-zona: az ekezet es a szokoz RENDBEN van. Csak a parancssort toro
  // jelekre szolunk -- es ott is javaslattal, nem tiltassal.
  if (raw.trimStart().startsWith('-')) {
    const fixed = raw.replace(/^[\s-]+/, '').trim()
    return {
      ok: false, zone, suggestion: fixed, code: 'leading_dash',
      message: T(lang,
        `A kötőjellel kezdődő nevet a parancsok kapcsolónak nézik. Javasolt név: ${fixed || '(adj meg egy nevet)'}`,
        `A name starting with a hyphen is read as an option by commands. Suggested name: ${fixed || '(please give a name)'}`),
    }
  }
  if (SHELL_HAZARD_RE.test(raw)) {
    const fixed = raw.replace(new RegExp(SHELL_HAZARD_RE.source, 'g'), ' ').replace(/\s+/g, ' ').trim()
    return {
      ok: false, zone, suggestion: fixed, code: 'shell_hazard',
      message: T(lang,
        `Ebben a névben olyan jel van, amit a parancssor magának értelmez, ezért egy későbbi mentés vagy másolás elhasalhat rajta. Ékezet és szóköz nyugodtan maradhat. Javasolt név: ${fixed || '(adj meg egy nevet)'}`,
        `This name contains a character the command line interprets for itself, so a later backup or copy can trip on it. Accents and spaces are fine to keep. Suggested name: ${fixed || '(please give a name)'}`),
    }
  }
  return ok
}

/**
 * A SZULO utvonala alapjan nezi meg a nevet -- ez a hivoknak a kenyelmes ut.
 *
 * A szulo, nem a keszulo elem sajat utja: kulonben egy `GIT_REPOS` NEVU mappa
 * letrehozasat magat is slugositani akarnank (`git-repos`), holott eppen az a
 * mappa az, aminek a neve fixen nagybetus (life-tree.ts, specifikacio 16.).
 * A gep-zona a `GIT_REPOS` TARTALMAra vonatkozik.
 */
export function checkNameForPath(parentRel: string, name: string, lang: string = APP_LANG): NameAdvice {
  return checkName(name, namingZone(parentRel), lang)
}

/**
 * IKON-KONVENCIO: melyik mappa milyen ikont kap.
 *
 * A kulcs ugyanaz a GEPI nev, amit a `life-tree.ts` NAMES tablaja es a
 * `life-hints.ts` hasznal -- szandekosan, mert a lemezre kerulo mappanev
 * nyelvfuggo, tehat nevre kotni nem lehet (egy angol telepitesen `Legal` all a
 * `Jogi` helyen). Egy teszt kikenyszeriti, hogy MINDEN fa-kulcsnak legyen
 * ikonja: uj mappa nem szulethet ikon nelkul.
 */
const ICONS: Record<string, string> = {
  // Felso szint
  companies: '🏢', knowledge: '📚', media: '🖼', digital: '🌐',
  inbox: '📥', shared: '🤝', archive: '📦', system: '⚙',

  // Szemely alatt
  identity: '🪪', personal: '👤', family: '👨‍👩‍👧', finance: '💰',
  legal: '⚖', authorities: '🏛', home: '🏠', work: '💼',
  projects: '🎯', health: '🩺', documents: '📄',

  // Ceg alatt
  companyAffairs: '🏢', correspondence: '✉', knowledgeBase: '📚',
  moreMaterial: '🗂', website: '🌍', development: '🛠', marketing: '📣',
  gitRepos: '🔀',

  // Media
  photos: '📷', videos: '🎬', audio: '🎧', scans: '🖨',

  // Digitalis
  domains: '🔗', devices: '💻', digitalServices: '☁',

  // Rendszer
  marvin: '🤖', storages: '🗄', trash: '🗑', git: '🔀',
}

/** Az alapertelmezes: amirol nincs szabaly, az sima mappa. Nem talalunk ki ikont. */
export const DEFAULT_FOLDER_ICON = '📁'

/** Egy GEPI kulcshoz tartozo ikon (vagy az alapertelmezes). */
export function iconForKey(key: string): string {
  return ICONS[key] || DEFAULT_FOLDER_ICON
}

/**
 * Egy LEMEZEN LEVO mappanevhez tartozo ikon.
 *
 * Mindket nyelvet felismeri (`lifeKeyForName`), mert egy magyarul keszult fat
 * egy angolra allitott gepen is fel kell ismerni.
 */
export function iconForFolderName(name: string): string {
  return iconForKey(lifeKeyForName(name))
}

/** A teljes tabla -- a felulet es a ketnyelvuseg-teszt ebbol dolgozik. */
export function iconTable(): Record<string, string> {
  return { ...ICONS }
}

/** Fa-kulcsok, amikhez nincs ikon. Ures lista = a konvencio teljes. */
export function keysWithoutIcon(): string[] {
  return lifeNameKeys().filter(k => !ICONS[k])
}
