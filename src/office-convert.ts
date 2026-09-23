/**
 * IRODAI DOKUMENTUM -> PDF (kanban #336, 7. fazis; spec 8 "DOCX V1" + 24).
 *
 * A bongeszo a .docx-et nem tudja megmutatni. A konnyu ut a spec szerint a
 * LibreOffice headless konverzio: a forrasbol keszul EGY PDF, es azt mar meg
 * tudja jeleniteni ugyanaz az elonezet, ami a PDF-et is mutatja -- nincs uj
 * megjelenito, nincs uj csomag-fuggoseg.
 *
 * FRISS TELEPITES: a LibreOffice NEM kotelezo, es NEM telepitjuk magunktol
 * (csomagtelepites = a tulajdonos jovahagyasa). Ha nincs meg, a Munkapad
 * TOVABBRA IS mukodik: a fajl letoltheto, a munkadarab szerkesztheto, csak a
 * beagyazott elonezet marad el -- es a felhasznalo EMBERI mondatot kap arrol,
 * mi hianyzik, mire hat, es hogyan szerezheto be.
 *
 * A NULLA KET DOLGOT JELENTHET. A "nem talalom a LibreOffice-t" ketfele lehet:
 *   - tenyleg nincs telepitve (ENOENT minden jeloltnel)      -> `not_installed`
 *   - van, de nem tudtam megkerdezni (jogosultsag, idotullepes, hibas
 *     MARVEEN_SOFFICE ut)                                    -> `check_failed`
 * A ketto MAS teendo, ezert SOHA nem mossuk ossze, es a `detail` mindig a
 * VALODI hibauzenetet viszi -- nem talalgatunk okot.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { STORE_DIR } from './config.js'
import { probeCommand, resetProbeCache, runVersion, type CommandProbe, type ConfiguredPath, type ProbeReason } from './capability-probe.js'
import { getEffectiveSettingValue } from './settings-store.js'

/** Amit a LibreOffice at tud alakitani, es amit a bongeszo magatol NEM mutat
 *  meg. Kiterjesztes -> emberi megnevezes (HU/EN), hogy a felulet ne egy
 *  kiterjesztest mondjon a felhasznalonak, hanem azt, MI ez a fajl. */
export const OFFICE_CONVERTIBLE: Record<string, { hu: string; en: string }> = {
  docx: { hu: 'Word-dokumentum', en: 'Word document' },
  doc: { hu: 'Word-dokumentum (regi)', en: 'Word document (legacy)' },
  odt: { hu: 'LibreOffice szoveges dokumentum', en: 'LibreOffice text document' },
  rtf: { hu: 'RTF dokumentum', en: 'RTF document' },
  xlsx: { hu: 'Excel-tablazat', en: 'Excel spreadsheet' },
  xls: { hu: 'Excel-tablazat (regi)', en: 'Excel spreadsheet (legacy)' },
  ods: { hu: 'LibreOffice tablazat', en: 'LibreOffice spreadsheet' },
  pptx: { hu: 'PowerPoint-bemutato', en: 'PowerPoint presentation' },
  ppt: { hu: 'PowerPoint-bemutato (regi)', en: 'PowerPoint presentation (legacy)' },
  odp: { hu: 'LibreOffice bemutato', en: 'LibreOffice presentation' },
}

export function officeExt(name: unknown): string | null {
  const ext = extname(String(name || '')).slice(1).toLowerCase()
  return Object.prototype.hasOwnProperty.call(OFFICE_CONVERTIBLE, ext) ? ext : null
}

export function isOfficeConvertible(name: unknown): boolean {
  return officeExt(name) !== null
}

/** Hova kerulnek az atalakitott PDF-ek. Szandekosan a `store/` ala, NEM a
 *  felhasznalo projektmappajaba: ez szarmaztatott, barmikor ujra eloallithato
 *  adat, es nem szemeteli tele azt a mappat, amiben a felhasznalo dolgozik.
 *  A teszt sajat mappat adhat (`MARVEEN_RENDER_CACHE`). */
export function renderCacheDir(): string {
  const override = (process.env['MARVEEN_RENDER_CACHE'] || '').trim()
  return override || join(STORE_DIR, 'workbench-render')
}

export type { ProbeReason }
/** A 8. fazis ota a mereset a kozos `capability-probe` vegzi (ugyanaz kell az
 *  FFmpeg-hez is). Ez a nev marad, hogy a hivo oldalak ne toredezzenek szet. */
export type SofficeProbe = CommandProbe

/** A MEGADOTT ut. Ketfelol johet, es a sorrend szandekos:
 *   1. `MARVEEN_SOFFICE` kornyezeti valtozo -- uzemeltetesi/teszt-fogas,
 *      adatbazis nelkul is mukodik.
 *   2. `WORKBENCH_LIBREOFFICE_PATH` beallitas -- EZT tudja a felhasznalo a
 *      FELULETROL megadni, tehat egy friss telepitesen ez az igazi ut:
 *      terminal es .env-szerkesztes nelkul.
 *  Ha egyik sincs: `null`, es a szokasos helyeken keressuk.
 *  A `source` azert utazik vele, hogy a hibauzenet meg tudja nevezni, MELYIK
 *  beallitast kell javitani -- ne a felhasznalo talalgassa. */
export function configuredSoffice(): ConfiguredPath | null {
  const env = (process.env['MARVEEN_SOFFICE'] || '').trim()
  if (env) return { path: env, source: 'MARVEEN_SOFFICE' }
  let setting = ''
  // A beallitas-tar hianya (friss telepites, nincs meg tabla) NEM hiba:
  // olyankor egyszeruen nincs megadott ut, es a szokasos helyeken keresunk.
  try { setting = String(getEffectiveSettingValue('WORKBENCH_LIBREOFFICE_PATH') ?? '').trim() } catch { setting = '' }
  if (setting) return { path: setting, source: 'WORKBENCH_LIBREOFFICE_PATH' }
  return null
}

/** Hol keressuk. Ha a felhasznalo MEGMONDTA, akkor CSAK ott -- ha az az ut
 *  rossz, azt meg kell tudnia, nem pedig csendben egy masik peldanyt hasznalni.
 *  Kulonben a PATH, majd a szokasos telepitesi helyek. Ezek NEM ennek a gepnek
 *  az azonositoi, hanem a LibreOffice sajat helyei. */
export function sofficeCandidates(): string[] {
  const configured = configuredSoffice()
  if (configured) return [configured.path]
  return [
    'soffice',
    'libreoffice',
    '/usr/bin/soffice',
    '/usr/lib/libreoffice/program/soffice',
    '/snap/bin/libreoffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  ]
}

/** Van-e LibreOffice ezen a gepen? */
export async function probeLibreOffice(opts: { force?: boolean; timeoutMs?: number; candidates?: string[] } = {}): Promise<SofficeProbe> {
  return probeCommand({
    id: 'soffice',
    configured: configuredSoffice(),
    candidates: sofficeCandidates(),
    versionArgs: ['--version'],
    timeoutMs: 20_000,
  }, opts)
}

/** Csak tesztnek/„mert allitottal rajta" esetre: felejtse el a mert allapotot. */
export function resetLibreOfficeProbe(): void {
  resetProbeCache('soffice')
}

/** A gyorsitotar HATARAI. Szarmaztatott adat: barmikor ujra eloallithato,
 *  tehat nem gyujtjuk vegtelenig. A regebbi vagy a hatarba nem fero PDF-ek
 *  magatol elmennek -- nem a felhasznalonak kell takaritania. */
export const RENDER_CACHE_MAX_FILES = 200
export const RENDER_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Egy felbeszakadt atalakitas ideiglenes mappaja ennyi ido utan szemet. */
export const RENDER_CACHE_TMP_MAX_AGE_MS = 60 * 60 * 1000

/** Takaritas a gyorsitotarban. SOHA nem nyul a gyorsitotar-mappan kivulre, es
 *  csak azt torli, amit maga hozott letre (`<kulcs>.pdf`, `tmp-*`). A hibajat
 *  elnyeli: egy sikertelen takaritas nem ronthatja el az atalakitast. */
export function gcRenderCache(now = Date.now()): { removed: number; kept: number } {
  const dir = renderCacheDir()
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return { removed: 0, kept: 0 } }
  let removed = 0
  const pdfs: { path: string; mtime: number }[] = []
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      // Felbeszakadt atalakitas maradeka (a sajat `finally` normalisan torli).
      if (name.startsWith('tmp-') && now - st.mtimeMs > RENDER_CACHE_TMP_MAX_AGE_MS) {
        try { rmSync(full, { recursive: true, force: true }); removed++ } catch { /* nem a felhasznalo baja */ }
      }
      continue
    }
    if (!name.toLowerCase().endsWith('.pdf')) continue
    if (now - st.mtimeMs > RENDER_CACHE_MAX_AGE_MS) {
      try { rmSync(full, { force: true }); removed++ } catch { /* nem a felhasznalo baja */ }
      continue
    }
    pdfs.push({ path: full, mtime: st.mtimeMs })
  }
  // A hatar folott a LEGREGEBBEN hasznaltak mennek elsokent.
  if (pdfs.length > RENDER_CACHE_MAX_FILES) {
    pdfs.sort((a, b) => a.mtime - b.mtime)
    for (const f of pdfs.slice(0, pdfs.length - RENDER_CACHE_MAX_FILES)) {
      try { rmSync(f.path, { force: true }); removed++ } catch { /* nem a felhasznalo baja */ }
    }
  }
  return { removed, kept: Math.min(pdfs.length, RENDER_CACHE_MAX_FILES) }
}

/** A gyorsitotar kulcsa: a FORRAS allapotabol szarmazik (ut + modositas +
 *  meret), tehat ha a fajl valtozik, magatol mas kulcs lesz -- elavult PDF-et
 *  nem lehet visszakapni. */
export function cacheKeyFor(abs: string): { ok: true; key: string; pdf: string } | { ok: false; code: 'missing_source'; detail: string } {
  try {
    const st = statSync(abs)
    const key = createHash('sha1').update(`${abs}:${Math.floor(st.mtimeMs)}:${st.size}`).digest('hex').slice(0, 24)
    return { ok: true, key, pdf: join(renderCacheDir(), `${key}.pdf`) }
  } catch (e) {
    return { ok: false, code: 'missing_source', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** Megvan MAR az atalakitott PDF? (Ez sync es olcso -- az elonezet ebbol
 *  tudja megmondani, kell-e meg varni.) */
export function cachedPdfFor(abs: string): string | null {
  const k = cacheKeyFor(abs)
  if (!k.ok) return null
  return existsSync(k.pdf) ? k.pdf : null
}

export type ConvertResult =
  | { ok: true; pdf: string; key: string; cached: boolean }
  | { ok: false; code: 'unsupported' | 'missing_source' | 'not_installed' | 'check_failed' | 'timeout' | 'convert_failed' | 'no_output'; detail: string | null; probe?: SofficeProbe }

// EGYSZERRE EGY atalakitas fut. Ket okbol: a LibreOffice egy kozos profil-
// mappat hasznal (parhuzamos indulasnal egymasra lepnenek), es egy terhelt
// flotta-gepen sem akarunk tiz soffice-t egyszerre. Az AZONOS kereseket
// osszevonjuk: ha ugyanazt a fajlt ketten kerik, egy konverzio lesz belole.
let queue: Promise<unknown> = Promise.resolve()
const inFlight = new Map<string, Promise<ConvertResult>>()

export async function convertOfficeToPdf(abs: string, opts: { timeoutMs?: number } = {}): Promise<ConvertResult> {
  if (!isOfficeConvertible(abs)) {
    return { ok: false, code: 'unsupported', detail: `${basename(abs)}: not an office document` }
  }
  const k = cacheKeyFor(abs)
  if (!k.ok) return { ok: false, code: 'missing_source', detail: k.detail }
  if (existsSync(k.pdf)) return { ok: true, pdf: k.pdf, key: k.key, cached: true }

  const running = inFlight.get(k.key)
  if (running) return running

  // FONTOS: ez csak a LEIRASA a munkanak -- nem indul el itt. A sorbaallitas
  // akkor hivja meg, amikor rakerul a sor; ha mar itt elindulna, a "queue" nem
  // sorositana semmit, csak ugy nezne ki, mintha sorositana.
  const doConvert = async (): Promise<ConvertResult> => {
    const probe = await probeLibreOffice()
    if (!probe.available) {
      return { ok: false, code: probe.reason === 'check_failed' ? 'check_failed' : 'not_installed', detail: probe.detail, probe }
    }
    const dir = renderCacheDir()
    const outDir = join(dir, `tmp-${k.key}`)
    const profile = join(dir, 'lo-profile')
    try {
      mkdirSync(outDir, { recursive: true })
      mkdirSync(profile, { recursive: true })
    } catch (e) {
      return { ok: false, code: 'convert_failed', detail: e instanceof Error ? e.message : String(e) }
    }
    try {
      const r = await runVersion(probe.path as string, [
        '--headless', '--norestore', '--nolockcheck', '--nodefault',
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--convert-to', 'pdf', '--outdir', outDir, abs,
      ], opts.timeoutMs ?? 180_000)
      if (!r.ok) {
        return { ok: false, code: r.code === 'timeout' ? 'timeout' : 'convert_failed', detail: r.detail }
      }
      // A LibreOffice a forras nevebol kepez nevet. NEM talalgatjuk: megnezzuk,
      // mi keletkezett a sajat, ures kimeneti mappaban.
      let made: string[] = []
      try { made = readdirSync(outDir).filter((f) => f.toLowerCase().endsWith('.pdf')) } catch { made = [] }
      if (!made.length) {
        // Lefutott, de PDF nincs. Ez KULON eset: a kimenetet adjuk vissza, hogy
        // lassuk, MIT mondott -- nem "sikerult"-et hazudunk.
        return { ok: false, code: 'no_output', detail: r.stdout.trim() || null }
      }
      renameSync(join(outDir, made[0] as string), k.pdf)
      // A szarmaztatott adat nem gyulhet vegtelenig -- a hataron tuli es a
      // regi PDF-ek most mennek el, nem "majd valamikor".
      gcRenderCache()
      return { ok: true, pdf: k.pdf, key: k.key, cached: false }
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }) } catch { /* a takaritas hibaja nem a felhasznalo baja */ }
    }
  }

  // Sorba allitas: a tenyleges futas megvarja az elotte allot (akkor is, ha az
  // elozo elhasalt -- egy hibas atalakitas nem allithatja meg a tobbit).
  const serialized = queue.then(doConvert, doConvert)
  queue = serialized.catch(() => undefined)
  inFlight.set(k.key, serialized)
  try {
    return await serialized
  } finally {
    inFlight.delete(k.key)
  }
}
