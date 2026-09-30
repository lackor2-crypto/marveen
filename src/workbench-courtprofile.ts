/**
 * CELBIROSAG-PROFILOK (kanban #441, v4 spec 7.4, K-1.36, K-1.37).
 *
 * A profil NEM beegetett szabalylista, hanem ADAT: profil -> szabalyverzio ->
 * ervenyesseg kezdete -> hivatalos forras (webcim) -> utolso ellenorzes datuma
 * -> kovetelmenyek. A kiindulo profilok (SEED_PROFILES) a hivatalos forrasokbol
 * vannak kiirva (a forras a profilban van); a `store/workbench-court-profiles.json`
 * felulirja vagy kiegesziti oket, igy a kovetelmenyek a program frissitese
 * nelkul is frissithetok. A program csak vegrehajtja az ellenorzest.
 *
 * Ha egy profilt regebben ellenoriztunk a hivatalos forrasban, mint
 * `MAX_AGE_DAYS`, a felulet figyelmeztet ("nezzem meg, van-e valtozas?").
 * A felulet "Nezd meg" gombja az Agentet kuldi a hivatalos forrashoz; ha valtozott
 * valami, az Agent uj szabalyverziot JAVASOL (proposeRule), es a tulajdonos
 * a sajat kattintasaval fogadja el -- akkor kerul a fajlba. A fajl verziokat
 * AD a kiindulo profilokhoz (verzionev szerint), nem cserel le profilt: igy egy
 * programfrissites uj szabalyverzioja es a tulajdonos elfogadott verzioja megfer
 * egymas mellett, a ma ervenyeset az ervenyesseg kezdete donti el.
 *
 * Az ellenorzes (K-1.37) a KESZ fajlokon fut (a beadvany PDF-je, mellekletenkent
 * egy PDF, vagy az egyesitett PDF): Poppler (pdfinfo, pdffonts, pdfdetach,
 * pdftotext) + a PDF nyers szerkezete (JavaScript, kulso program inditasa,
 * hang/video). Minden eredmeny mellett ott van, melyik szabalyverzio szerint.
 * A Marveen NEM allitja, hogy a beadvany megfelel: azt mondja, mit nezett meg,
 * mit talalt, es mi az, amit nem tud gepi uton ellenorizni (pl. az alairas).
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getDb } from './db.js'
import { STORE_DIR } from './config.js'
import { which } from './life-inbox-systools.js'
import { meaningfulChars } from './workbench-docread.js'

// ---------------------------------------------------------------------------
// Adatszerkezet
// ---------------------------------------------------------------------------

export type Level = 'error' | 'warn'
export type Text = { hu: string; en: string }

export interface Requirements {
  /** Kereshetoseg: minden oldalon legyen szoveg. null: nem kovetelmeny. */
  searchable?: Level | null
  /** Minden betutipus beagyazva (a dokumentum mindenhol ugyanigy jelenjen meg). */
  fonts_embedded?: Level | null
  /** Titkositas / jelszo. `print_only`: csak az szamit hibanak, ha a nyomtatas tiltott. */
  encryption?: Level | null
  encryption_scope?: 'any' | 'print_only'
  javascript?: Level | null
  /** Kulso program inditasa (/Launch). */
  launch?: Level | null
  embedded_files?: Level | null
  /** Hang, video (/RichMedia, /Movie, /Sound, /Screen). */
  media?: Level | null
  /** Kitoltheto urlapmezo (a „lapitott” PDF-et kero birosagnal). */
  form_fields?: Level | null
  /** MB-ban; null: nincs, vagy birosagonkent mas (lasd `notes`). */
  max_file_mb?: number | null
  max_total_mb?: number | null
  max_files?: number | null
  filename?: { max_length?: number | null; pattern?: string | null; numbered?: boolean; rule: Text } | null
}

export interface RuleVersion {
  /** Pl. "ERVB 2025". */
  version: string
  /** EEEE-HH-NN: ettol ervenyes. */
  valid_from: string
  /**
   * true: a forras nem kozli, mikortol ervenyes. A `valid_from` ilyenkor az a
   * nap, amikor a forrast elolvastuk (csak a sorrendhez kell), a felulet nem
   * allitja, hogy "ettol ervenyes".
   */
  valid_from_unknown?: boolean
  sources: { title: string; url: string }[]
  requirements: Requirements
  /** Amit gepi uton NEM ellenorzunk (alairas, benyujtasi csatorna ...): tajekoztatas. */
  notes?: Text[]
}

export interface CourtProfile {
  id: string
  name: Text
  /** EEEE-HH-NN: mikor neztuk meg utoljara a hivatalos forrasban. */
  last_checked: string
  versions: RuleVersion[]
}

/** Ennyi nap utan kerdez ra a Marvin, hogy van-e valtozas (kb. 6 honap). A fajlban felulirhato. */
export const DEFAULT_MAX_AGE_DAYS = 183

const T = (hu: string, en: string): Text => ({ hu, en })

/**
 * A kiindulo profilok. Minden ertek a `sources` alatti hivatalos forrasbol
 * szarmazik, 2026-09-30-an a forras szovegevel osszevetve. Ami ott csak
 * ajanlas ("soll"), az figyelmeztetes; ami kotelezo, az hiba. Amit a forras
 * NEM ir elo, de a birosag a fajllal nehezen boldogul (szkennelt oldal, jelszo),
 * az legfeljebb figyelmeztetes, es a `notes` megmondja, hogy nem a forrasbol jon.
 */
export const SEED_PROFILES: CourtProfile[] = [
  {
    id: 'de-ervv',
    name: T('Németország (beA / EGVP, ERVV)', 'Germany (beA / EGVP, ERVV)'),
    last_checked: '2026-09-30',
    versions: [{
      version: 'ERVB 2025',
      valid_from: '2025-07-30',
      sources: [
        { title: 'ERVV § 2 (gesetze-im-internet.de)', url: 'https://www.gesetze-im-internet.de/ervv/__2.html' },
        { title: 'ERVB 2025, BAnz AT 29.07.2025 B2 (justiz.de)', url: 'https://justiz.de/laender-bund-europa/elektronische_kommunikation/bundesanzeiger_29_07_2025.pdf' },
      ],
      requirements: {
        // ERVB 2025 1.a: "orts- und systemunabhängig darstellbar"; 6.a: Druckbarkeit.
        fonts_embedded: 'warn',
        encryption: 'error', encryption_scope: 'print_only',
        // 1.a: "soll kein eingebundenes Objekt ... keine ... Scripts, insbesondere ... JavaScript".
        javascript: 'warn', launch: 'warn', embedded_files: 'warn', media: 'warn',
        // 1.a: "Zulässig sind Formularfelder ohne JavaScript."
        form_fields: null,
        // Sem az ERVV § 2, sem az ERVB 2025 nem irja elo a kereshetoseget: csak jelezzuk.
        searchable: 'warn',
        max_files: 1000, max_total_mb: 200, max_file_mb: null,
        filename: {
          max_length: 90,
          pattern: '^[A-Za-zÄÖÜäöüß0-9_-]+(\\.[A-Za-z0-9]+)?$',
          numbered: true,
          rule: T(
            'legfeljebb 90 karakter (a kiterjesztéssel együtt), csak a német ábécé betűi (ä, ö, ü, ß is), számjegy, aláhúzás és kötőjel; több fájlnál logikus sorszámozás',
            'at most 90 characters including the extension; only letters of the German alphabet (ä, ö, ü, ß too), digits, underscore and hyphen; logical numbering for several files',
          ),
        },
      },
      notes: [
        T('Ügyvédi beadásnál minősített elektronikus aláírás vagy egyszerű aláírás a beA-n (biztonságos átviteli úton) kell. Ezt a Marvin nem tudja gépi úton ellenőrizni.',
          'A lawyer filing needs a qualified electronic signature, or a simple signature sent through beA (a secure transmission route). Marvin cannot check this by machine.'),
        T('Az ERVV ajánlja, hogy a beadvány mellé XJustiz szerinti XML-adatlap is menjen (bíróság, ügyszám, felek). Ezt a beadó program (beA) készíti.',
          'The ERVV recommends a structured XJustiz XML record with the filing (court, case number, parties). The filing program (beA) makes it.'),
        T('A kereshető szöveget a mai ERVV és ERVB nem írja elő. A Marvin a szkennelt oldalt csak jelzi, mert a bíróság abban nem tud keresni.',
          'Searchable text is not required by the current ERVV and ERVB. Marvin only flags a scanned page, because the court cannot search in it.'),
      ],
    }],
  },
  {
    id: 'us-cmecf',
    name: T('USA szövetségi bíróság (PACER CM/ECF)', 'US federal court (PACER CM/ECF)'),
    last_checked: '2026-09-30',
    versions: [{
      version: 'CM/ECF 1.6 PDF validation',
      valid_from: '2020-12-21',
      sources: [
        { title: 'CM/ECF PDF Validation (District of New Mexico)', url: 'https://www.nmd.uscourts.gov/cmecf-pdf-validation' },
        { title: 'PACER FAQ: PDF size limit', url: 'https://pacer.uscourts.gov/help/faqs/there-limit-size-pdf-files-which-cmecf-will-accept' },
        { title: 'Text-searchable PDFs, Local Rules 25.1(e), 25.2(b)(3) (2nd Circuit)', url: 'https://www.ca2.uscourts.gov/clerk/case_filing/electronic_filing/how_to_use_cmecf/text_searchable_pdfs.html' },
      ],
      requirements: {
        // A CM/ECF 1.6 gepi ellenorzese ezeket utasitja vissza: JavaScript, jelszo,
        // kulso programot indito szkript, belso csatolmany, hang es video.
        encryption: 'error', encryption_scope: 'any',
        javascript: 'error', launch: 'error', embedded_files: 'error', media: 'error',
        // A szkennelt dokumentumot a CM/ECF elfogadja; a kereshetoseget es a lapitott
        // urlapot a helyi szabalyok kerik (pl. 2. kor: minden PDF kereshető) -> jelzes.
        searchable: 'warn', form_fields: 'warn', fonts_embedded: 'warn',
        max_file_mb: null, max_total_mb: null, max_files: null,
        filename: null,
      },
      notes: [
        T('A fájlméret-korlátot minden bíróság maga szabja meg. Nézd meg a PACER „Court CM/ECF Lookup” oldalán, és ha kell, bontsd a nagy mellékletet több fájlra.',
          'Each court sets its own file size limit. Look it up with the PACER "Court CM/ECF Lookup" and split a large exhibit into several files if needed.'),
        T('A CM/ECF a szkennelt dokumentumot elfogadja. A kereshető szöveget és a „lapított” (kitölthető mező nélküli) PDF-et sok bíróság helyi szabálya (local rules) kéri, van, ahol minden PDF-re (például a 2. körzeti fellebbviteli bíróság). Nézd meg a célbíróság helyi szabályát.',
          'CM/ECF accepts scanned documents. Many courts\' local rules ask for text-searchable and flattened (no fillable fields) PDFs, some for every PDF (e.g. the Second Circuit). Check the local rules of the target court.'),
      ],
    }],
  },
  {
    id: 'hu-eper',
    name: T('Magyarország (e-per, Ügyfélkapu+)', 'Hungary (e-per, Client Gate+)'),
    last_checked: '2026-09-30',
    versions: [{
      version: 'birosag.hu informatikai segédlet',
      // Az oldal nem kozli, mikortol ervenyes: ez az olvasas napja.
      valid_from: '2026-09-30',
      valid_from_unknown: true,
      sources: [
        { title: 'Informatikai segédlet az elektronikus beadványok benyújtásához (birosag.hu)', url: 'https://birosag.hu/ugyfeleknek/elektronikus-ugyintezes/elektronikus-kapcsolattartas-birosagokkal/e-per/e-kapcsolattartas-az-egyes-ugytipusokban/polgari-gazdasagi-munkaugyi-es-kozigazgatasi-ugyek/informatikai-segedlet-az-elektronikus-beadvanyok' },
      ],
      requirements: {
        // A segedlet csak a formatumot es a meretet szabja meg (150 MB / fajl, 300 MB egyutt).
        searchable: 'warn', fonts_embedded: 'warn',
        encryption: 'warn', encryption_scope: 'any',
        javascript: 'warn', launch: 'warn', embedded_files: 'warn', media: 'warn',
        form_fields: null,
        max_file_mb: 150, max_total_mb: 300, max_files: null,
        filename: null,
      },
      notes: [
        T('A beadványt űrlapon (IFORM) kell benyújtani, a PDF-ek ennek mellékletei. A hitelesítés AVDH-val vagy minősített elektronikus aláírással történik: ezt a Marvin nem tudja gépi úton ellenőrizni.',
          'The filing goes in on a form (IFORM); the PDFs are its attachments. Authentication is by AVDH or a qualified electronic signature: Marvin cannot check this by machine.'),
        T('A bíróság segédlete csak a fájlformátumot és a méretet szabja meg (fájlonként 150 MB, együtt 300 MB). A nagyobb fájl a bíróság külön kisalkalmazásával (.xcz) küldhető be. A többi pontot a Marvin csak jelzi.',
          'The court guide only sets the file format and the size (150 MB per file, 300 MB together). A larger file can be sent with the court\'s separate small application (.xcz). Marvin only flags the other points.'),
      ],
    }],
  },
  {
    id: 'general',
    name: T('Általános (bármely bíróság, hatóság)', 'General (any court or authority)'),
    last_checked: '2026-09-30',
    versions: [{
      version: 'általános / general',
      valid_from: '2026-01-01',
      valid_from_unknown: true,
      sources: [],
      requirements: {
        searchable: 'warn', fonts_embedded: 'warn',
        encryption: 'warn', encryption_scope: 'any',
        javascript: 'warn', launch: 'warn', embedded_files: 'warn', media: 'warn',
        form_fields: null, max_file_mb: null, max_total_mb: null, max_files: null, filename: null,
      },
      notes: [
        T('Ez nem egy bíróság szabálya, hanem a legtöbb helyen elvárt alap: kereshető szöveg, beágyazott betűtípus, jelszó és beágyazott program nélkül. A konkrét bíróság szabályát nézd meg.',
          'This is not a court rule but the common baseline: searchable text, embedded fonts, no password and no embedded programs. Check the specific court rules.'),
      ],
    }],
  },
]

// ---------------------------------------------------------------------------
// Betoltes: a kiindulo profilok + a store-ban levo felulirasok
// ---------------------------------------------------------------------------

interface ProfileFile { max_age_days?: number; profiles?: unknown[]; checked?: Record<string, string> }

export function profilesFile(): string {
  return process.env['MARVEEN_COURT_PROFILES_FILE'] || join(STORE_DIR, 'workbench-court-profiles.json')
}

type FileRead = { ok: true; file: ProfileFile } | { ok: false; error: string }

/**
 * A profilfajl. A HIANYZO fajl a friss telepites rendes allapota (nincs benne
 * semmi); a HIBAS fajl nem ugyanaz: azt a felulet kiirja, es a Marveen nem ir
 * bele, amig ki nem javitjak -- kulonben a kezi javitasok vesznenek el.
 */
function readProfileFile(): FileRead {
  const f = profilesFile()
  if (!existsSync(f)) return { ok: true, file: {} }
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as unknown
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: 'the file is not a JSON object' }
    const x = j as ProfileFile
    if (x.profiles !== undefined && !Array.isArray(x.profiles)) return { ok: false, error: '"profiles" is not a list' }
    return { ok: true, file: x }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e).slice(0, 300) }
  }
}

/** Atomi iras: felbeszakadt irasbol nem lesz fel fajl. */
function writeProfileFile(next: ProfileFile): void {
  const f = profilesFile()
  mkdirSync(dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, f)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const LEVEL_KEYS = ['searchable', 'fonts_embedded', 'encryption', 'javascript', 'launch', 'embedded_files', 'media', 'form_fields'] as const
const NUM_KEYS = ['max_file_mb', 'max_total_mb', 'max_files'] as const
/** A kovetelmenyek kulcsai, abban a sorrendben, ahogy a felulet a valtozasokat felsorolja. */
export const REQUIREMENT_KEYS = [...LEVEL_KEYS, 'encryption_scope', ...NUM_KEYS, 'filename'] as const

const isText = (t: unknown): t is Text =>
  !!t && typeof t === 'object' && typeof (t as Text).hu === 'string' && typeof (t as Text).en === 'string' && !!(t as Text).hu.trim()

/** Fajlnev-mintat csak akkor fogadunk el, ha rovid, lefordul, es nincs benne egymasba agyazott ismetles (az lassu lehet). */
function safePattern(p: string): boolean {
  if (p.length > 200 || /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(p)) return false
  try { new RegExp(p, 'u'); return true } catch { return false }
}

/** A kovetelmenyek ellenorzese: csak ismert kulcs, ertelmes ertekkel (a fajlbol es az Agent javaslatabol is ez jon). */
export function checkRequirements(raw: unknown): { ok: true; requirements: Requirements } | { ok: false; detail: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, detail: 'requirements must be an object' }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((LEVEL_KEYS as readonly string[]).includes(k)) {
      if (v !== null && v !== 'error' && v !== 'warn') return { ok: false, detail: `${k}: "error", "warn" or null` }
      out[k] = v
    } else if (k === 'encryption_scope') {
      if (v !== 'any' && v !== 'print_only') return { ok: false, detail: 'encryption_scope: "any" or "print_only"' }
      out[k] = v
    } else if ((NUM_KEYS as readonly string[]).includes(k)) {
      const okNum = v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1_000_000 && (k !== 'max_files' || Number.isInteger(v)))
      if (!okNum) return { ok: false, detail: `${k}: a positive number or null` }
      out[k] = v
    } else if (k === 'filename') {
      if (v === null) { out[k] = null; continue }
      const f = v as Record<string, unknown>
      if (!f || typeof f !== 'object' || !isText(f['rule'])) return { ok: false, detail: 'filename: { rule: {hu, en}, max_length, pattern, numbered } or null' }
      const ml = f['max_length']
      if (ml != null && !(typeof ml === 'number' && Number.isInteger(ml) && ml >= 8 && ml <= 255)) return { ok: false, detail: 'filename.max_length: 8 ... 255' }
      const pat = f['pattern']
      if (pat != null && (typeof pat !== 'string' || !safePattern(pat))) return { ok: false, detail: 'filename.pattern: a short regular expression without nested repetition' }
      const rule = f['rule'] as Text
      out[k] = { max_length: (ml as number | null | undefined) ?? null, pattern: (pat as string | null | undefined) ?? null, numbered: f['numbered'] === true, rule: { hu: rule.hu, en: rule.en } }
    } else {
      return { ok: false, detail: `unknown requirement: ${k} (known: ${REQUIREMENT_KEYS.join(', ')})` }
    }
  }
  return { ok: true, requirements: out as Requirements }
}

function versionProblem(v: unknown): string | null {
  const x = v as RuleVersion
  if (!x || typeof x !== 'object' || typeof x.version !== 'string' || !x.version.trim() || x.version.length > 120) return 'version: a name (at most 120 characters)'
  if (!DATE_RE.test(String(x.valid_from))) return `${x.version}: valid_from must be YYYY-MM-DD`
  if (!Array.isArray(x.sources) || !x.sources.every((s) => s && typeof s.title === 'string' && typeof s.url === 'string' && /^https:\/\/[^\s]+$/.test(s.url))) {
    return `${x.version}: sources must be a list of { title, url } with https addresses`
  }
  const r = checkRequirements(x.requirements)
  if (!r.ok) return `${x.version}: ${r.detail}`
  if (x.notes !== undefined && !(Array.isArray(x.notes) && x.notes.every(isText))) return `${x.version}: notes must be a list of { hu, en }`
  return null
}

function profileProblem(p: unknown): string | null {
  const x = p as CourtProfile
  if (!x || typeof x !== 'object') return 'not an object'
  if (typeof x.id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(x.id)) return 'id: 2-40 lowercase letters, digits or hyphens'
  if (!isText(x.name)) return 'name: { hu, en }'
  if (!DATE_RE.test(String(x.last_checked))) return 'last_checked must be YYYY-MM-DD'
  if (!Array.isArray(x.versions) || !x.versions.length) return 'versions: at least one rule version'
  for (const v of x.versions) {
    const e = versionProblem(v)
    if (e) return e
  }
  return null
}

export interface LoadedProfiles {
  profiles: CourtProfile[]
  max_age_days: number
  /** A profilfajl nem olvashato (a beepitett profilok mennek); null: rendben vagy nincs fajl. */
  file_error: string | null
  /** A fajl hibas bejegyzesei, amelyeket kihagytunk -- a felulet kiirja oket. */
  skipped: { id: string; problem: string }[]
}

export function loadProfiles(): LoadedProfiles {
  const read = readProfileFile()
  const file = read.ok ? read.file : {}
  const byId = new Map(SEED_PROFILES.map((p) => [p.id, structuredClone(p)]))
  const skipped: LoadedProfiles['skipped'] = []
  for (const raw of file.profiles || []) {
    const problem = profileProblem(raw)
    if (problem) {
      skipped.push({ id: String((raw as { id?: unknown } | null)?.id ?? '?').slice(0, 60), problem })
      continue
    }
    const p = structuredClone(raw as CourtProfile)
    const base = byId.get(p.id)
    if (!base) { byId.set(p.id, p); continue }
    // A fajl verziokat ad a beepitetthez; azonos verzionevnel a fajlbeli nyer.
    const names = new Set(p.versions.map((v) => v.version))
    byId.set(p.id, {
      id: p.id, name: p.name,
      last_checked: p.last_checked > base.last_checked ? p.last_checked : base.last_checked,
      versions: [...base.versions.filter((v) => !names.has(v.version)), ...p.versions],
    })
  }
  for (const [id, d] of Object.entries(file.checked || {})) {
    const p = byId.get(id)
    if (p && DATE_RE.test(d) && d > p.last_checked) p.last_checked = d
  }
  const age = Number(file.max_age_days)
  return {
    profiles: [...byId.values()],
    max_age_days: Number.isInteger(age) && age > 0 && age <= 3650 ? age : DEFAULT_MAX_AGE_DAYS,
    file_error: read.ok ? null : read.error,
    skipped,
  }
}

export function getProfile(id: string | null | undefined): CourtProfile | null {
  if (!id) return null
  return loadProfiles().profiles.find((p) => p.id === id) ?? null
}

const today = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A ma ervenyes szabalyverzio: a legkesobbi, ami mar ervenybe lepett (ha egyik sem, a legkorabbi). */
export function currentVersion(p: CourtProfile, on = today()): RuleVersion {
  const sorted = [...p.versions].sort((a, b) => a.valid_from.localeCompare(b.valid_from))
  const valid = sorted.filter((v) => v.valid_from <= on)
  return valid.length ? valid[valid.length - 1] : sorted[0]
}

export function daysSince(date: string, on = today()): number {
  return Math.floor((Date.parse(on + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86_400_000)
}

export interface ProfileSummary {
  id: string
  name: Text
  version: string
  valid_from: string
  valid_from_unknown: boolean
  last_checked: string
  /** Hany napja neztuk meg utoljara a hivatalos forrasban. */
  age_days: number
  stale: boolean
  sources: { title: string; url: string }[]
  notes: Text[]
  filename_rule: Text | null
  requirements: Requirements
}

export function profileSummary(p: CourtProfile, maxAge = loadProfiles().max_age_days): ProfileSummary {
  const v = currentVersion(p)
  const age = daysSince(p.last_checked)
  return {
    id: p.id, name: p.name, version: v.version, valid_from: v.valid_from, valid_from_unknown: v.valid_from_unknown === true,
    last_checked: p.last_checked, age_days: age, stale: age > maxAge, sources: v.sources, notes: v.notes || [],
    filename_rule: v.requirements.filename ? v.requirements.filename.rule : null,
    requirements: v.requirements,
  }
}

export function listProfileSummaries(loaded = loadProfiles()): ProfileSummary[] {
  return loaded.profiles.map((p) => profileSummary(p, loaded.max_age_days))
}

type WriteFail = { ok: false; code: 'file_broken'; detail: string }

/** A fajl modositasa: HIBAS fajlba nem irunk (a kezi javitas elveszne), azt elobb ki kell javitani. */
function updateProfileFile(change: (f: ProfileFile) => ProfileFile): { ok: true } | WriteFail {
  const read = readProfileFile()
  if (!read.ok) return { ok: false, code: 'file_broken', detail: `${profilesFile()}: ${read.error}` }
  writeProfileFile(change(read.file))
  return { ok: true }
}

/** A tulajdonos jelzi: megnezte a hivatalos forrast, a profil naprakesz (a datum a fajlba kerul). */
export function markProfileChecked(id: string): { ok: true; profile: ProfileSummary } | { ok: false; code: 'not_found' } | WriteFail {
  if (!getProfile(id)) return { ok: false, code: 'not_found' }
  const w = updateProfileFile((f) => ({ ...f, checked: { ...(f.checked || {}), [id]: today() } }))
  if (!w.ok) return w
  return { ok: true, profile: profileSummary(getProfile(id)!) }
}

/** Ennyi nap utan kerdez ra a Marvin a valtozasra; a feluleten allithato. */
export const MAX_AGE_RANGE = { min: 30, max: 3650 }

export function setMaxAgeDays(days: unknown): { ok: true; max_age_days: number } | { ok: false; code: 'bad_input'; detail: string } | WriteFail {
  const n = Number(days)
  if (!Number.isInteger(n) || n < MAX_AGE_RANGE.min || n > MAX_AGE_RANGE.max) {
    return { ok: false, code: 'bad_input', detail: `max_age_days: a whole number of days, ${MAX_AGE_RANGE.min} ... ${MAX_AGE_RANGE.max}` }
  }
  const w = updateProfileFile((f) => ({ ...f, max_age_days: n }))
  if (!w.ok) return w
  return { ok: true, max_age_days: n }
}

// ---------------------------------------------------------------------------
// A munkadarab valasztott profilja
// ---------------------------------------------------------------------------

let tablesDb: unknown = null

function ensureTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_court_profile (
      work_item_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wb_court_check (
      work_item_id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      checked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wb_court_rule_proposal (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      work_item_id TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    )
  `)
  tablesDb = db
}

export function itemProfileId(itemId: string): string | null {
  ensureTables()
  const r = getDb().prepare('SELECT profile_id FROM wb_court_profile WHERE work_item_id = ?').get(itemId) as { profile_id: string } | undefined
  return r && getProfile(r.profile_id) ? r.profile_id : null
}

export function setItemProfile(itemId: string, profileId: unknown): { ok: true; profile_id: string | null } | { ok: false; code: 'bad_input'; detail: string } {
  ensureTables()
  const id = profileId == null ? '' : String(profileId)
  if (!id) {
    getDb().prepare('DELETE FROM wb_court_profile WHERE work_item_id = ?').run(itemId)
    return { ok: true, profile_id: null }
  }
  if (!getProfile(id)) return { ok: false, code: 'bad_input', detail: `unknown court profile: ${id}` }
  getDb().prepare(`INSERT INTO wb_court_profile (work_item_id, profile_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET profile_id = excluded.profile_id, updated_at = excluded.updated_at`)
    .run(itemId, id, Math.floor(Date.now() / 1000))
  return { ok: true, profile_id: id }
}

/** A legutobbi ellenorzes eredmenye egy veglegesiteshez (verzio) kotve. */
export function saveCourtCheck(itemId: string, versionId: string, result: CourtCheckResult): void {
  ensureTables()
  getDb().prepare(`INSERT INTO wb_court_check (work_item_id, version_id, result_json, checked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET version_id = excluded.version_id, result_json = excluded.result_json, checked_at = excluded.checked_at`)
    .run(itemId, versionId, JSON.stringify(result), Math.floor(Date.now() / 1000))
}

export function lastCourtCheck(itemId: string): { version_id: string; result: CourtCheckResult } | null {
  ensureTables()
  const r = getDb().prepare('SELECT version_id, result_json FROM wb_court_check WHERE work_item_id = ?').get(itemId) as { version_id: string; result_json: string } | undefined
  if (!r) return null
  try { return { version_id: r.version_id, result: JSON.parse(r.result_json) as CourtCheckResult } } catch { return null }
}

export interface ItemCourtState {
  profile_id: string | null
  profile: ProfileSummary | null
  profiles: ProfileSummary[]
  /** A legutobbi ellenorzes (a hivo donti el, hogy a mostani vegleges valtozathoz tartozik-e). */
  check: { version_id: string; result: CourtCheckResult } | null
  available: boolean
  max_age_days: number
  file: string
  file_error: string | null
  skipped: { id: string; problem: string }[]
  /** Az Agent nyitott szabalyfrissitesi javaslatai (a tulajdonos fogadja el). */
  proposals: RuleProposal[]
}

/** A munkadarab profilja a feluletnek: a valasztott, a valaszthatok, az utolso ellenorzes. */
export function itemCourtState(itemId: string): ItemCourtState {
  const loaded = loadProfiles()
  const profiles = listProfileSummaries(loaded)
  const id = itemProfileId(itemId)
  return {
    profile_id: id, profile: profiles.find((p) => p.id === id) ?? null, profiles, check: lastCourtCheck(itemId), available: courtCheckAvailable(),
    max_age_days: loaded.max_age_days, file: profilesFile(), file_error: loaded.file_error, skipped: loaded.skipped,
    proposals: listProposals(),
  }
}

// ---------------------------------------------------------------------------
// Szabalyfrissites: az Agent javasol, a tulajdonos fogadja el
// ---------------------------------------------------------------------------

export type ProposalKind = 'new_version' | 'new_profile' | 'unchanged'
export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'superseded'

/** Egy kovetelmeny (vagy a verzio egy adata) valtozasa a mostani ervenyes verziohoz kepest. */
export interface RuleDiff { key: string; from: unknown; to: unknown }

export interface RuleProposal {
  id: string
  profile_id: string
  kind: ProposalKind
  /** Uj profilnal a neve; kulonben a meglevo profil neve. */
  name: Text
  /** Az Agent indoklasa (a tulajdonos nyelven) es a megnezett forrasok. */
  reason: string
  checked_sources: string[]
  /** A javasolt teljes szabalyverzio (`unchanged` eseten null). */
  version: RuleVersion | null
  /** A MOST ervenyes verzio, amihez kepest a `diff` keszult (uj profilnal null). */
  base_version: string | null
  diff: RuleDiff[]
  status: ProposalStatus
  work_item_id: string | null
  created_at: number
}

interface StoredProposal { name: Text | null; reason: string; checked_sources: string[]; version: RuleVersion | null }

const httpsUrl = (u: unknown): u is string => typeof u === 'string' && u.length <= 2000 && /^https:\/\/[^\s]+$/.test(u)

/** A javasolt verzio a kovetelmenyekkel egyutt, tisztitva (ismeretlen mezo nem kerul a fajlba). */
function cleanVersion(v: RuleVersion): RuleVersion {
  const out: RuleVersion = {
    version: v.version.trim(), valid_from: v.valid_from,
    sources: v.sources.map((s) => ({ title: String(s.title).slice(0, 300), url: s.url })),
    requirements: (checkRequirements(v.requirements) as { ok: true; requirements: Requirements }).requirements,
  }
  if (v.valid_from_unknown === true) out.valid_from_unknown = true
  if (v.notes?.length) out.notes = v.notes.map((n) => ({ hu: n.hu, en: n.en }))
  return out
}

export function ruleDiff(base: RuleVersion | null, next: RuleVersion): RuleDiff[] {
  const out: RuleDiff[] = []
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  if (!base || base.version !== next.version) out.push({ key: 'version', from: base?.version ?? null, to: next.version })
  if (!base || base.valid_from !== next.valid_from || !!base.valid_from_unknown !== !!next.valid_from_unknown) {
    out.push({ key: 'valid_from', from: base ? (base.valid_from_unknown ? null : base.valid_from) : null, to: next.valid_from_unknown ? null : next.valid_from })
  }
  for (const k of REQUIREMENT_KEYS) {
    const a = base?.requirements[k as keyof Requirements], b = next.requirements[k as keyof Requirements]
    if (!same(a, b)) out.push({ key: k, from: a ?? null, to: b ?? null })
  }
  if (!base || !same(base.sources, next.sources)) out.push({ key: 'sources', from: base?.sources ?? [], to: next.sources })
  if (!base || !same(base.notes || [], next.notes || [])) out.push({ key: 'notes', from: base?.notes ?? [], to: next.notes ?? [] })
  return out
}

export interface ProposeInput {
  profile_id?: unknown
  /** Uj profilnal: { hu, en }. */
  name?: unknown
  /** true: a forras szerint nincs valtozas (a tulajdonos az elfogadassal az ellenorzes datumat frissiti). */
  unchanged?: unknown
  /** Az uj szabalyverzio; a `requirements`-ben eleg a valtozo kulcs, a tobbi a mostani verziobol jon. */
  version?: unknown
  reason?: unknown
  checked_sources?: unknown
  work_item_id?: string | null
}

export function proposeRule(input: ProposeInput): { ok: true; proposal: RuleProposal } | { ok: false; code: 'bad_input'; detail: string } {
  ensureTables()
  const bad = (detail: string) => ({ ok: false as const, code: 'bad_input' as const, detail })
  const profileId = String(input.profile_id ?? '').trim()
  if (!/^[a-z0-9-]{2,40}$/.test(profileId)) return bad('profile_id: 2-40 lowercase letters, digits or hyphens')
  const reason = String(input.reason ?? '').trim()
  if (!reason || reason.length > 3000) return bad('reason: say what you looked at and what changed (at most 3000 characters)')
  const checked = Array.isArray(input.checked_sources) ? input.checked_sources : []
  if (!checked.length || checked.length > 20 || !checked.every(httpsUrl)) return bad('checked_sources: the https addresses you actually read (1-20)')
  const existing = getProfile(profileId)
  let kind: ProposalKind
  let version: RuleVersion | null = null
  let name: Text | null = null
  if (input.unchanged === true) {
    if (!existing) return bad(`unknown court profile: ${profileId}`)
    kind = 'unchanged'
  } else {
    const raw = input.version as Partial<RuleVersion> | null | undefined
    if (!raw || typeof raw !== 'object') return bad('version: the new rule version, or unchanged: true')
    const base = existing ? currentVersion(existing) : null
    const reqIn = raw.requirements
    if (reqIn !== undefined && (!reqIn || typeof reqIn !== 'object' || Array.isArray(reqIn))) return bad('version.requirements must be an object')
    const merged = { ...(base?.requirements || {}), ...(reqIn || {}) }
    const candidate = { ...raw, requirements: merged, notes: raw.notes ?? base?.notes }
    const problem = versionProblem(candidate)
    if (problem) return bad(`version: ${problem}`)
    if (!(candidate.sources as unknown[]).length) return bad('version.sources: at least one official source')
    version = cleanVersion(candidate as RuleVersion)
    if (existing) {
      kind = 'new_version'
      if (base && !ruleDiff(base, version).length) return bad('the proposed version is the same as the current one; send unchanged: true instead')
      // Korabbi kezdettel, mas neven a javaslat sosem lenne a mai ervenyes: a javitas a mostani verzio nevet tartja meg.
      if (base && version.version !== base.version && version.valid_from < base.valid_from) {
        return bad(`version.valid_from (${version.valid_from}) is earlier than the current version "${base.version}" (${base.valid_from}); to correct the current version keep its name`)
      }
    } else {
      if (!isText(input.name)) return bad('name: { hu, en } for a new court profile')
      kind = 'new_profile'
      name = { hu: String((input.name as Text).hu).slice(0, 200), en: String((input.name as Text).en).slice(0, 200) }
    }
  }
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const stored: StoredProposal = { name, reason, checked_sources: checked as string[], version }
  const db = getDb()
  db.transaction(() => {
    // Profilonkent egy nyitott javaslat: a regebbi a frissebb forrasolvasas miatt elavult.
    db.prepare(`UPDATE wb_court_rule_proposal SET status = 'superseded', decided_at = ? WHERE profile_id = ? AND status = 'open'`).run(now, profileId)
    db.prepare(`INSERT INTO wb_court_rule_proposal (id, profile_id, kind, proposal_json, status, work_item_id, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`)
      .run(id, profileId, kind, JSON.stringify(stored), input.work_item_id ?? null, now)
  })()
  return { ok: true, proposal: getProposal(id)! }
}

interface ProposalRow { id: string; profile_id: string; kind: ProposalKind; proposal_json: string; status: ProposalStatus; work_item_id: string | null; created_at: number }

/** A kulonbseg MINDIG a mostani ervenyes verziohoz kepest (nem a javaslat idejehez). */
function toProposal(r: ProposalRow): RuleProposal | null {
  let s: StoredProposal
  try { s = JSON.parse(r.proposal_json) as StoredProposal } catch { return null }
  const p = getProfile(r.profile_id)
  const base = p ? currentVersion(p) : null
  return {
    id: r.id, profile_id: r.profile_id, kind: r.kind,
    name: p ? p.name : (s.name || { hu: r.profile_id, en: r.profile_id }),
    reason: s.reason, checked_sources: s.checked_sources, version: s.version,
    base_version: base ? base.version : null,
    diff: s.version ? ruleDiff(base, s.version) : [],
    status: r.status, work_item_id: r.work_item_id, created_at: r.created_at,
  }
}

export function getProposal(id: string): RuleProposal | null {
  ensureTables()
  const r = getDb().prepare('SELECT * FROM wb_court_rule_proposal WHERE id = ?').get(id) as ProposalRow | undefined
  return r ? toProposal(r) : null
}

export function listProposals(status: ProposalStatus = 'open'): RuleProposal[] {
  ensureTables()
  const rows = getDb().prepare('SELECT * FROM wb_court_rule_proposal WHERE status = ? ORDER BY created_at DESC LIMIT 50').all(status) as ProposalRow[]
  return rows.map(toProposal).filter((p): p is RuleProposal => !!p)
}

type DecideFail = { ok: false; code: 'not_found' | 'not_open' } | WriteFail

function closeProposal(id: string, status: ProposalStatus): void {
  getDb().prepare('UPDATE wb_court_rule_proposal SET status = ?, decided_at = ? WHERE id = ?').run(status, Math.floor(Date.now() / 1000), id)
}

/**
 * A tulajdonos elfogadja: az uj verzio a profilfajlba kerul (a beepitett profil
 * mellé, verzionev szerint), es az ellenorzes datuma mai lesz. A fajl meglevo,
 * de HIBAS bejegyzesehez nem fuzunk: az ugy is kimaradna, csendben.
 */
export function acceptProposal(id: string): { ok: true; proposal: RuleProposal; profile: ProfileSummary } | DecideFail {
  const prop = getProposal(id)
  if (!prop) return { ok: false, code: 'not_found' }
  if (prop.status !== 'open') return { ok: false, code: 'not_open' }
  if (prop.kind === 'unchanged') {
    const m = markProfileChecked(prop.profile_id)
    if (!m.ok) return m.code === 'not_found' ? { ok: false, code: 'not_found' } : m
  } else {
    const v = prop.version!
    const read = readProfileFile()
    if (!read.ok) return { ok: false, code: 'file_broken', detail: `${profilesFile()}: ${read.error}` }
    const list = [...(read.file.profiles || [])]
    const at = list.findIndex((x) => (x as { id?: unknown } | null)?.id === prop.profile_id)
    if (at >= 0) {
      const problem = profileProblem(list[at])
      if (problem) return { ok: false, code: 'file_broken', detail: `${profilesFile()}: ${prop.profile_id}: ${problem}` }
      const cur = list[at] as CourtProfile
      list[at] = { ...cur, last_checked: today(), versions: [...cur.versions.filter((x) => x.version !== v.version), v] }
    } else {
      list.push({ id: prop.profile_id, name: prop.name, last_checked: today(), versions: [v] })
    }
    writeProfileFile({ ...read.file, profiles: list, checked: { ...(read.file.checked || {}), [prop.profile_id]: today() } })
  }
  closeProposal(id, 'accepted')
  return { ok: true, proposal: getProposal(id)!, profile: profileSummary(getProfile(prop.profile_id)!) }
}

export function rejectProposal(id: string): { ok: true; proposal: RuleProposal } | DecideFail {
  const prop = getProposal(id)
  if (!prop) return { ok: false, code: 'not_found' }
  if (prop.status !== 'open') return { ok: false, code: 'not_open' }
  closeProposal(id, 'rejected')
  return { ok: true, proposal: getProposal(id)! }
}

// ---------------------------------------------------------------------------
// Fajlnev a profil szerint
// ---------------------------------------------------------------------------

const TRANSLIT: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ő: 'oe', ú: 'u', ű: 'ue', Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ő: 'Oe', Ú: 'U', Ű: 'Ue' }

/**
 * A profil fajlnev-szabalyanak megfelelo nev (pl. ERVB: `01_Klage.pdf`). A nem
 * engedett betuket atirja (ő -> oe), a tobbit alahuzasra csereli, sorszamot tesz
 * ele, ha a profil kerI, es a hosszt a kiterjesztessel egyutt vagja.
 * Ha a profilnak nincs fajlnev-szabalya, a nev valtozatlan.
 */
export function profileFileName(name: string, p: CourtProfile | null, index: number, total: number): string {
  const rule = p ? currentVersion(p).requirements.filename : null
  if (!rule) return name
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(name)!
  const ext = m[2] || ''
  // A magyar ekezetek atirasa; mas nyelv ekezetes betuje (c, s, e ...) az alapbetuje lesz.
  const base = (chars: string, src = m[1]): string => [...src].map((c) => TRANSLIT[c] ?? (new RegExp(`[${chars}]`).test(c) ? c : c.normalize('NFD').replace(/\p{M}/gu, ''))).join('')
    .replace(new RegExp(`[^${chars}]+`, 'g'), '_').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '') || 'Dokument'
  const build = (stemIn: string): string => {
    let stem = stemIn
    if (rule.numbered && total > 1) stem = `${String(index + 1).padStart(String(total).length < 2 ? 2 : String(total).length, '0')}_${stem}`
    const max = rule.max_length || 255
    if (stem.length + ext.length > max) stem = stem.slice(0, Math.max(1, max - ext.length)).replace(/[_-]+$/, '')
    return stem + ext
  }
  const out = build(base('A-Za-zÄÖÜäöüß0-9_-'))
  // Ha a profil mintaja a nemet betuket sem engedi (mas birosag), csak angol betu marad (ä -> ae, ß -> ss).
  if (rule.pattern && safePattern(rule.pattern) && !new RegExp(rule.pattern, 'u').test(out)) {
    const DE: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' }
    return build(base('A-Za-z0-9_-', m[1].replace(/[äöüÄÖÜß]/g, (c) => DE[c])))
  }
  return out
}

// ---------------------------------------------------------------------------
// Egy PDF gepi vizsgalata
// ---------------------------------------------------------------------------

export interface PdfFacts {
  bytes: number
  pages: number
  encrypted: boolean
  print_allowed: boolean
  javascript: boolean
  launch: boolean
  embedded_files: number
  media: boolean
  form: 'none' | 'AcroForm' | 'XFA'
  fonts_not_embedded: string[]
  /** Oldalak, amelyeken nincs kiolvashato szoveg (szkennelt vagy ures oldal). */
  no_text_pages: number[]
}

function run(bin: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const exe = which(bin)
  if (!exe) return Promise.resolve({ ok: false, error: `${bin} is not installed` })
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: 120_000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: `${bin}: ${(stderr || err.message || '').toString().trim().slice(0, 300)}` })
      else resolve({ ok: true, out: stdout })
    })
  })
}

export function courtCheckAvailable(): boolean {
  return !!which('pdfinfo') && !!which('pdffonts') && !!which('pdftotext') && !!which('pdfdetach')
}

/**
 * A PDF nyers szerkezeteben elofordulo nevek (/JavaScript, /Launch ...): a
 * fajl szovege ES a tomoritett objektumfolyamok (ObjStm) tartalma, mert a
 * modern PDF-ben a szotarak nagy resze tomoritve van.
 */
export function pdfNames(buf: Buffer): Set<string> {
  const names = new Set<string>()
  const scan = (s: string): void => { for (const m of s.matchAll(/\/(JavaScript|JS|Launch|RichMedia|Movie|Sound|Screen|EmbeddedFile|EmbeddedFiles|XFA|AcroForm)\b/g)) names.add(m[1]) }
  const raw = buf.toString('latin1')
  scan(raw)
  const re = /<<((?:(?!>>\s*stream)[\s\S]){0,2000}?)>>\s*stream\r?\n/g
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    if (!/\/Type\s*\/ObjStm/.test(m[1]) || !/\/FlateDecode/.test(m[1])) continue
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    try { scan(inflateSync(buf.subarray(start, end)).toString('latin1')) } catch { /* serult folyam: kihagyjuk */ }
    re.lastIndex = end
  }
  return names
}

export async function inspectPdf(pdf: Buffer): Promise<{ ok: true; facts: PdfFacts } | { ok: false; detail: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-court-'))
  const f = join(dir, 'in.pdf')
  try {
    writeFileSync(f, pdf)
    const info = await run('pdfinfo', [f])
    if (!info.ok) return { ok: false, detail: info.error }
    const field = (k: string): string => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(info.out)?.[1] || '').trim()
    const pages = Number(field('Pages')) || 0
    const enc = field('Encrypted')
    const encrypted = /^yes/i.test(enc)
    const print_allowed = !encrypted || !/print:no/i.test(enc)
    const formField = field('Form')
    const names = pdfNames(pdf)
    const fonts = await run('pdffonts', [f])
    if (!fonts.ok) return { ok: false, detail: fonts.error }
    const notEmb: string[] = []
    for (const line of fonts.out.split('\n').slice(2)) {
      const cols = line.trim().split(/\s+/)
      // name type [encoding...] emb sub uni object ID: az "emb" a hatulrol 5.
      if (cols.length >= 7 && cols[cols.length - 5] === 'no' && !notEmb.includes(cols[0])) notEmb.push(cols[0])
    }
    const det = await run('pdfdetach', ['-list', f])
    const embedded = det.ok ? Number(/^(\d+)\s+embedded files?/m.exec(det.out)?.[1] || 0) : 0
    const noText: number[] = []
    for (let p = 1; p <= pages; p++) {
      const t = await run('pdftotext', ['-q', '-enc', 'UTF-8', '-f', String(p), '-l', String(p), f, '-'])
      if (t.ok && meaningfulChars(t.out) === 0) noText.push(p)
    }
    return {
      ok: true,
      facts: {
        bytes: pdf.length, pages, encrypted, print_allowed,
        javascript: /^yes/i.test(field('JavaScript')) || names.has('JavaScript') || names.has('JS'),
        launch: names.has('Launch'),
        embedded_files: Math.max(embedded, names.has('EmbeddedFile') ? 1 : 0),
        media: names.has('RichMedia') || names.has('Movie') || names.has('Sound') || names.has('Screen'),
        form: /xfa/i.test(formField) || names.has('XFA') ? 'XFA' : /acro/i.test(formField) ? 'AcroForm' : 'none',
        fonts_not_embedded: notEmb,
        no_text_pages: noText,
      },
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* mar nincs meg */ }
  }
}

// ---------------------------------------------------------------------------
// Az ellenorzes (K-1.37)
// ---------------------------------------------------------------------------

export interface CheckFile { name: string; pdf: Buffer; role: 'main' | 'bundle' | 'annex'; label?: string; annex_id?: string; path?: string }

export type CourtIssueKey =
  | 'not_searchable' | 'fonts_not_embedded' | 'encrypted' | 'javascript' | 'launch' | 'embedded_files' | 'media' | 'form_fields'
  | 'file_too_large' | 'total_too_large' | 'too_many_files' | 'filename' | 'unreadable'

export interface CourtIssue {
  key: CourtIssueKey
  level: Level
  /** A fajl, amelyrol szol (a mellekletnel a cimkeje is). */
  file?: string
  label?: string
  annex_id?: string
  /** Oldalszamok, betutipusok, meretek -- a felulet ebbol mondatot rak ossze. */
  detail?: Record<string, unknown>
  /** Amit a Marvin meg tud csinalni: kereshető masolat a melleklet eredetijerol. */
  fix?: 'searchable'
}

export interface CourtCheckResult {
  profile_id: string
  profile_name: Text
  version: string
  valid_from: string
  valid_from_unknown?: boolean
  last_checked: string
  stale: boolean
  checked_at: string
  files: { name: string; role: string; label?: string; bytes: number; pages: number }[]
  issues: CourtIssue[]
  errors: number
  warnings: number
  notes: Text[]
  sources: { title: string; url: string }[]
}

const MB = 1024 * 1024

export async function checkFiles(p: CourtProfile, files: CheckFile[]): Promise<CourtCheckResult> {
  const { max_age_days } = loadProfiles()
  const v = currentVersion(p)
  const r = v.requirements
  const issues: CourtIssue[] = []
  const out: CourtCheckResult['files'] = []
  const push = (lvl: Level | null | undefined, i: Omit<CourtIssue, 'level'>): void => { if (lvl) issues.push({ ...i, level: lvl }) }
  let total = 0
  for (const f of files) {
    const where = { file: f.name, ...(f.label ? { label: f.label } : {}), ...(f.annex_id ? { annex_id: f.annex_id } : {}) }
    total += f.pdf.length
    const got = await inspectPdf(f.pdf)
    if (!got.ok) {
      issues.push({ key: 'unreadable', level: 'error', ...where, detail: { error: got.detail } })
      out.push({ name: f.name, role: f.role, label: f.label, bytes: f.pdf.length, pages: 0 })
      continue
    }
    const x = got.facts
    out.push({ name: f.name, role: f.role, label: f.label, bytes: x.bytes, pages: x.pages })
    if (x.no_text_pages.length) push(r.searchable, { key: 'not_searchable', ...where, detail: { pages: x.no_text_pages }, ...(f.annex_id ? { fix: 'searchable' as const } : {}) })
    if (x.fonts_not_embedded.length) push(r.fonts_embedded, { key: 'fonts_not_embedded', ...where, detail: { fonts: x.fonts_not_embedded } })
    if (x.encrypted && (r.encryption_scope !== 'print_only' || !x.print_allowed)) push(r.encryption, { key: 'encrypted', ...where, detail: { print_allowed: x.print_allowed } })
    if (x.javascript) push(r.javascript, { key: 'javascript', ...where })
    if (x.launch) push(r.launch, { key: 'launch', ...where })
    if (x.embedded_files) push(r.embedded_files, { key: 'embedded_files', ...where, detail: { n: x.embedded_files } })
    if (x.media) push(r.media, { key: 'media', ...where })
    if (x.form !== 'none') push(r.form_fields, { key: 'form_fields', ...where, detail: { form: x.form } })
    if (r.max_file_mb && x.bytes > r.max_file_mb * MB) push('error', { key: 'file_too_large', ...where, detail: { mb: +(x.bytes / MB).toFixed(1), max: r.max_file_mb } })
    const fn = r.filename
    if (fn) {
      const long = !!fn.max_length && [...f.name].length > fn.max_length
      const bad = !!fn.pattern && safePattern(fn.pattern) && !new RegExp(fn.pattern, 'u').test(f.name)
      if (long || bad) push('error', { key: 'filename', ...where, detail: { length: [...f.name].length, max: fn.max_length ?? null } })
    }
  }
  if (r.max_total_mb && total > r.max_total_mb * MB) push('error', { key: 'total_too_large', detail: { mb: +(total / MB).toFixed(1), max: r.max_total_mb } })
  if (r.max_files && files.length > r.max_files) push('error', { key: 'too_many_files', detail: { n: files.length, max: r.max_files } })
  return {
    profile_id: p.id, profile_name: p.name, version: v.version, valid_from: v.valid_from, valid_from_unknown: v.valid_from_unknown === true, last_checked: p.last_checked,
    stale: daysSince(p.last_checked) > max_age_days, checked_at: new Date().toISOString(),
    files: out, issues,
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warn').length,
    notes: v.notes || [], sources: v.sources,
  }
}
