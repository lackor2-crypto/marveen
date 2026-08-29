// A BEERKEZO-LANC -- a specifikacio 22-23. pontja.
//
// A 22. pont: barmit bele lehessen dobni a BEERKEZO mappaba (szken, PDF,
// e-mail melleklet, letoltes, fenykep, birosagi irat, banki dokumentum), es a
// besorolas egy LANCON menjen vegig:
//
//   KIHEZ TARTOZIK? -> MELYIK TERULET? -> MELYIK ORSZAG?* -> MELYIK UGY?
//   -> MELYIK DOKUMENTUMTIPUS? -> HOVA KERULJON?
//
// A lanc lepesei NEM egy kulon adatszerkezetbol jonnek: MAGA A FA a lanc. Az
// elso szint a szemelyek es a cegek ("kihez tartozik"), a masodik a
// kategoriak ("melyik terulet"), a harmadik -- ahol van -- az orszag, es igy
// tovabb. Ezert ez a modul nem masolja le a fa szerkezetet: minden lepesnel
// megkerdezi a lemezt. Egy lemasolt lanc az elso fa-bovitesnel elavulna.
//
// A 23. pont HAROM biztonsagi szabalya, es hogy melyiket MI tartja be:
//
//   1. "SOHA ne talalja ki, kihez tartozik" -- ez a modul EGYETLEN helyen sem
//      valaszt gazdat. Nincs talalgato heurisztika, nincs "a fajlnevben
//      szerepel a neved, tehat a tied". A cel mappat mindig EMBER jeloli ki;
//      a modul csak a valaszthato lepeseket adja.
//   2. "SOHA ne irjon felul" -- az athelyezest a `moveLife()` vegzi, ami
//      azonos nevnel MEGALL (`code: 'exists'`). Itt csak annyi a dolgunk, hogy
//      ezt a felulet MAR AZ ELONEZETBEN lassa, ne csak a kattintas utan.
//   3. "SOHA ne tegyen jelszot, API-kulcsot, tokent az eletfaba" -- ezt a
//      `credentialRisk()` fogja meg, es a mozgatas ELOTT all: a gyanus fajl
//      nem megy be a faba, hanem egy emberi mondatot kap (Vault).
//
// A NULLA KET DOLGOT JELENTHET. Az ures Beerkezo negy KULONBOZO allapot lehet,
// es mind a negyet kulon mondjuk ki (`InboxStatus.reason`): nincs depo / nincs
// meg fa / a mappa nem olvashato / tenyleg ures. A darabszambol egyik sem
// kovetkeztetheto ki -- ezert kerdezzuk meg magat a forrast.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { APP_LANG } from './config.js'
import { inboxDir } from './life-tree.js'
import { explorerRoot, listLife, moveLife, toLifeRel, humanLocation, humanSize, type MoveResult } from './life-explorer.js'

function T(lang: string, hu: string, en: string): string {
  return lang === 'en' ? en : hu
}

/**
 * Miert nincs (vagy miert nem tudjuk, hogy van-e) tetel a Beerkezoben.
 *
 *  - `ok`          -- a mappa megvan es olvashato. A darabszam VALODI.
 *  - `no-depot`    -- meg nincs beallitva a raktar. Nem hiba, beallitas.
 *  - `no-folder`   -- van raktar, de a BEERKEZO mappa meg nem keszult el.
 *  - `unreadable`  -- a mappa OTT VAN, de nem tudtuk kiolvasni. EZ A LEGROSSZABB
 *                     eset: a nulla ilyenkor hazugsag lenne.
 */
export type InboxReason = 'ok' | 'no-depot' | 'no-folder' | 'unreadable'

export interface InboxItem {
  name: string
  /** Utvonal a fa gyokeretol. Ezt kuldi vissza a felulet. */
  rel: string
  isDir: boolean
  size: number
  sizeHuman: string
  mtime: string
  /**
   * Ha nem ures: EZ a fajl jelszot/kulcsot/tokent tartalmazhat, ezert nem megy
   * be a faba. A szoveg megmondja, mit tegyen helyette a felhasznalo.
   */
  credentialWarning: string
}

export interface InboxStatus {
  reason: InboxReason
  /** A mappa teljes utja, vagy ures. */
  dir: string
  /** A darabszam CSAK `reason === 'ok'` eseten jelent valamit. */
  count: number
  items: InboxItem[]
  /** Emberi mondat: mit lat a felhasznalo, es mi a kovetkezo lepes. */
  message: string
  /** Ha `unreadable`: a TENYLEGES hibauzenet. Sosem talalgatott ok. */
  error: string
}

/**
 * Fajlnevek, amik hitelesito adatot sejtetnek (23. pont, 3. szabaly).
 *
 * SZANDEKOSAN a NEV alapjan dont, nem a tartalom alapjan: egy jelszofajl
 * kinyitasa maga is kockazat, es egy titkositott kulcstar (`.kdbx`) tartalmat
 * amugy sem latnank. A dontes iranya is szandekos: inkabb alljon meg egy
 * artatlan fajlnal (a felhasznalo tovabbengedi), mint hogy egy kulcs
 // csendben bekeruljon a faba -- onnan mar szinkronizalodna is.
 */
const CRED_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.kdbx', '.keychain', '.jks', '.ppk', '.asc', '.gpg'])
const CRED_WORDS = [
  'jelszo', 'jelszó', 'jelszavak', 'password', 'passwd', 'secret', 'titok',
  'apikey', 'api-key', 'api_key', 'token', 'credential', 'credentials',
  'id_rsa', 'id_ed25519', 'private-key', 'privatekey', '.env', 'kulcs', 'keystore',
]

/** Ures sztring, ha nincs gyanu; kulonben a MONDAT, amit a felhasznalo lat. */
export function credentialRisk(name: string, lang: string = APP_LANG): string {
  const n = String(name || '').toLowerCase()
  const ext = extname(n)
  const gyanus = CRED_EXT.has(ext) || CRED_WORDS.some((w) => n.includes(w))
  if (!gyanus) return ''
  return T(lang,
    'Ez jelszót, API-kulcsot vagy tokent tartalmazhat. Az életfába ilyen NEM kerülhet – tedd a Marvin Vaultba. Ha biztosan nem az, előbb nevezd át.',
    'This may contain a password, API key or token. Such files must NOT go into the life tree – put it in the Marvin Vault. If you are sure it is not, rename it first.')
}

/**
 * Mi van a Beerkezoben -- es ha semmi, MIERT.
 */
export function inboxStatus(lang: string = APP_LANG): InboxStatus {
  const ures = { count: 0, items: [] as InboxItem[], error: '' }
  if (!explorerRoot()) {
    return {
      ...ures, reason: 'no-depot', dir: '',
      message: T(lang,
        'Még nincs beállítva, hol tárolja a Marveen a fájljaidat. Nyisd meg a Depó oldalt, és válaszd ki a mappát.',
        'The storage location is not set up yet. Open the Depot page and pick the folder.'),
    }
  }
  const dir = inboxDir(lang)
  if (!dir || !existsSync(dir)) {
    return {
      ...ures, reason: 'no-folder', dir: dir || '',
      message: T(lang,
        'A BEÉRKEZŐ mappa még nem készült el. Nyisd meg az Életfa oldalt, és hozd létre a könyvtárszerkezetet.',
        'The INBOX folder does not exist yet. Open the Life tree page and create the folder structure.'),
    }
  }
  let nevek: string[]
  try {
    nevek = readdirSync(dir).filter((f) => !f.startsWith('.'))
  } catch (err: any) {
    // A NULLA ITT HAZUGSAG LENNE. A mappa ott van, csak nem latunk bele.
    return {
      ...ures, reason: 'unreadable', dir,
      error: String(err?.message || err),
      message: T(lang,
        `A BEÉRKEZŐ mappát nem tudtam kiolvasni, ezért NEM tudom, van-e benne bármi: ${String(err?.message || err)}`,
        `I could not read the INBOX folder, so I do NOT know whether it holds anything: ${String(err?.message || err)}`),
    }
  }
  const items: InboxItem[] = []
  for (const name of nevek) {
    const abs = join(dir, name)
    let st: ReturnType<typeof statSync> | null = null
    try { st = statSync(abs) } catch { st = null }
    items.push({
      name,
      rel: toLifeRel(abs),
      isDir: st ? st.isDirectory() : false,
      size: st && st.isFile() ? st.size : 0,
      sizeHuman: st && st.isFile() ? humanSize(st.size) : '',
      mtime: st ? new Date(st.mtimeMs).toISOString() : '',
      credentialWarning: credentialRisk(name, lang),
    })
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  return {
    reason: 'ok', dir, count: items.length, items, error: '',
    message: items.length
      ? T(lang, `${items.length} tétel vár besorolásra.`, `${items.length} item(s) waiting to be filed.`)
      : T(lang, 'A BEÉRKEZŐ üres – nincs mit besorolni.', 'The INBOX is empty – nothing to file.'),
  }
}

/**
 * A besorolasi lanc EGY lepese: hova lehet innen tovabbmenni.
 *
 * A `rel` a MOSTANI hely a faban (ures sztring = a gyoker). A valasz a benne
 * levo mappak -- vagyis pontosan a kovetkezo kerdes lehetseges valaszai. A
 * `question` mondja meg, MELYIK kerdesnel jarunk; a melyseg alapjan, mert a fa
 * felepitese eppen a lanc.
 *
 * Ha nincs tovabbi mappa, a lanc VEGET ertuk: ide mar le lehet tenni az iratot.
 */
export interface ChainStep {
  rel: string
  /** Emberi utvonal a cimsorba. */
  display: string
  /** Melyik lanc-kerdesnel jarunk. */
  question: string
  /** A valaszthato mappak. */
  choices: Array<{ name: string; rel: string; hint: string }>
  /** Igaz, ha innen mar nem megy tovabb a lanc -- ide le lehet tenni. */
  leaf: boolean
  /** Emberi mondat, ha a lista uressegenek KULON oka van. */
  message: string
}

/** A lanc kerdesei, melyseg szerint (22. pont). */
function chainQuestion(depth: number, lang: string): string {
  const hu = [
    'Kihez tartozik?',
    'Melyik terület?',
    'Melyik ország vagy ügy?',
    'Melyik ügy vagy dokumentumtípus?',
    'Hova kerüljön pontosan?',
  ]
  const en = [
    'Who does it belong to?',
    'Which area?',
    'Which country or case?',
    'Which case or document type?',
    'Where exactly should it go?',
  ]
  const lista = lang === 'en' ? en : hu
  return lista[Math.min(depth, lista.length - 1)]
}

export function inboxChainStep(rel: string, lang: string = APP_LANG): ChainStep {
  const tiszta = String(rel || '').replace(/^[\\/]+|[\\/]+$/g, '')
  const depth = tiszta ? tiszta.split('/').filter(Boolean).length : 0
  const listing = listLife(tiszta, { lang })
  // A BEERKEZO onmagaba nem sorolhato be: kivesszuk a valaszthato celok kozul.
  const inbox = inboxDir(lang)
  const inboxRel = inbox ? toLifeRel(inbox) : ''
  const choices = listing.folders
    .filter((f) => f.rel !== inboxRel)
    .map((f) => ({ name: f.name, rel: f.rel, hint: f.hint || '' }))
  return {
    rel: tiszta,
    display: listing.display,
    question: chainQuestion(depth, lang),
    choices,
    leaf: choices.length === 0,
    // Ket kulon ok, ket kulon mondat: a listazas maga is elhasalhatott.
    message: listing.message
      ? listing.message
      : (choices.length ? '' : T(lang,
        'Innen nem megy tovább a lánc – ide már le lehet tenni az iratot.',
        'The chain ends here – the document can be filed at this place.')),
  }
}

export interface FilePlan {
  name: string
  rel: string
  /** A cel TELJES relativ utja, ahova kerulne. */
  targetRel: string
  /** `ok` | `exists` | `credential` | `missing` | `no_target` */
  status: 'ok' | 'exists' | 'credential' | 'missing' | 'no_target'
  message: string
}

/**
 * ELONEZET: mi tortenne, ha most besorolnank. A lemezhez NEM nyul.
 *
 * A 23. pont 2. szabalya (`SOHA ne irjon felul`) igy nem csak a mozgataskor
 * all meg, hanem MAR ITT lathato: a felhasznalo a kattintas ELOTT latja, hogy
 * a celban van ilyen nevu fajl.
 */
export function inboxPreview(names: string[], targetRel: string, lang: string = APP_LANG): {
  plans: FilePlan[]
  targetDisplay: string
  message: string
} {
  const cel = String(targetRel || '').replace(/^[\\/]+|[\\/]+$/g, '')
  const dir = inboxDir(lang)
  const plans: FilePlan[] = []
  if (!dir) {
    return {
      plans, targetDisplay: '',
      message: T(lang, 'Nincs beállítva a raktár, ezért nincs BEÉRKEZŐ mappa sem.', 'No depot is set, so there is no INBOX folder either.'),
    }
  }
  // A cel letezese KULON kerdes. Ha nincs meg, minden terv `no_target`.
  const celAbs = cel ? join(explorerRoot() || '', ...cel.split('/')) : ''
  let celOk = false
  try { celOk = !!celAbs && statSync(celAbs).isDirectory() } catch { celOk = false }
  for (const name of names) {
    const forras = join(dir, basename(String(name || '')))
    const kock = credentialRisk(basename(String(name || '')), lang)
    const terv: FilePlan = {
      name: basename(String(name || '')),
      rel: toLifeRel(forras),
      targetRel: cel ? `${cel}/${basename(String(name || ''))}` : basename(String(name || '')),
      status: 'ok',
      message: '',
    }
    if (!existsSync(forras)) {
      terv.status = 'missing'
      terv.message = T(lang, 'Ez a tétel már nincs a BEÉRKEZŐ-ben. Frissítsd a listát.', 'This item is no longer in the INBOX. Refresh the list.')
    } else if (kock) {
      // A 3. szabaly. A hitelesito adat MEG ELONEZETBEN sem kap zold utat.
      terv.status = 'credential'
      terv.message = kock
    } else if (!celOk) {
      terv.status = 'no_target'
      terv.message = T(lang, 'Előbb válaszd ki, hova kerüljön – a lánc még nem ért véget.', 'Pick the destination first – the chain has not finished yet.')
    } else if (existsSync(join(celAbs, terv.name))) {
      terv.status = 'exists'
      terv.message = T(lang,
        `A célmappában már van ilyen nevű: ${terv.name}. Nem írom felül – előbb nevezd át valamelyiket.`,
        `The target folder already has one called ${terv.name}. I will not overwrite it – rename one of them first.`)
    }
    plans.push(terv)
  }
  const mehet = plans.filter((p) => p.status === 'ok').length
  const all = plans.length - mehet
  return {
    plans,
    targetDisplay: celOk ? humanLocation(cel) : '',
    message: plans.length === 0
      ? T(lang, 'Nem jelöltél ki tételt.', 'You have not selected any item.')
      : T(lang,
        `${mehet} tétel mehet, ${all} megáll – a megállókat egyenként nézd meg.`,
        `${mehet} item(s) can go, ${all} stop – check the stopped ones one by one.`),
  }
}

/**
 * BESOROLAS. Csak azt mozgatja, amit az elonezet zoldre tett.
 *
 * A gazdat NEM talalja ki: a `targetRel`-t a felhasznalo jelolte ki a lancon
 * vegigmenve. Ez a fuggveny nem valaszt helyette.
 */
export function inboxFile(names: string[], targetRel: string, lang: string = APP_LANG): {
  moved: Array<{ name: string; rel: string }>
  failed: Array<{ name: string; message: string }>
  message: string
} {
  const elonezet = inboxPreview(names, targetRel, lang)
  const moved: Array<{ name: string; rel: string }> = []
  const failed: Array<{ name: string; message: string }> = []
  for (const terv of elonezet.plans) {
    if (terv.status !== 'ok') {
      failed.push({ name: terv.name, message: terv.message })
      continue
    }
    const r: MoveResult = moveLife(terv.rel, String(targetRel || ''), lang)
    if (r.ok) moved.push({ name: terv.name, rel: r.rel })
    else failed.push({ name: terv.name, message: r.message })
  }
  return {
    moved, failed,
    message: failed.length
      ? T(lang,
        `${moved.length} tétel besorolva, ${failed.length} megállt – a listában látod, melyik miért.`,
        `${moved.length} item(s) filed, ${failed.length} stopped – the list shows which and why.`)
      : T(lang, `${moved.length} tétel besorolva.`, `${moved.length} item(s) filed.`),
  }
}
