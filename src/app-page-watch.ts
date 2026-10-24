// APP-OLDAL FIGYELO (#764, Boss TG 10183).
//
// Nyilvanos Google Play / Apple App Store oldalakat olvas (CSAK olvas, a
// fejlesztoi konzolhoz nincs hozzaferes), naponta egyszer, es szol, ha a
// figyelt szam MAGASABBRA UGRIK. A figyelt oldalak listaja ADAT (a felulet
// adja meg), nem kod: semmilyen konkret app vagy ceg neve nincs ebben a fajlban.
//
// Mit lehet MERNI (nem talalgatas, a valos oldalak alapjan):
//  - Google Play: az oldal a letoltest kerekitett savban mutatja ("100+"), de az
//    oldal adatai kozott egy kozelebbi szam is ott van (a sav utan allo 2. szam).
//    Mindkettot elmentjuk; a figyelt ertek a pontosabb szam, ha nincs, a sav minimuma.
//  - Apple App Store: letoltesszamot NEM mutat. Az ertekelesek szama (osszeg) az
//    egyetlen nyilvanos jel; ha nincs ertekeles, a szam 0, es azt is kimondjuk.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { STORE_DIR } from './config.js'
import { atomicWriteFileSync } from './web/atomic-write.js'

/** Csak ezek a nyilvanos aruhaz-hostok engedettek: a figyelo nem tud tetszoleges cimet lekerni. */
export const WATCH_HOSTS = ['play.google.com', 'apps.apple.com'] as const
export type WatchKind = 'play' | 'apple'

export interface WatchPage { id: string; label: string; url: string }
export interface WatchState {
  /** A figyelt szam (Play: pontosabb szam vagy sav-minimum; Apple: ertekelesek osszege). */
  value: number | null
  /** Google Play savja ("100+"), Apple-nel ures. */
  band: string
  checkedAt: string
  /** Az utolso sikertelen meres tenyleges hibauzenete; ures, ha az utolso meres sikerult. */
  error: string
  /** Mikor valtozott utoljara a figyelt szam. */
  changedAt: string
}
export interface WatchFile { pages: WatchPage[]; state: Record<string, WatchState> }
export interface Reading { kind: WatchKind; value: number | null; band: string }

export function watchFilePath(): string { return join(STORE_DIR, 'app-page-watch.json') }

export function readWatchFile(file = watchFilePath()): WatchFile {
  const empty: WatchFile = { pages: [], state: {} }
  if (!existsSync(file)) return empty
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    const pages: WatchPage[] = Array.isArray(raw?.pages)
      ? raw.pages.filter((p: any) => p && typeof p.id === 'string' && typeof p.url === 'string')
          .map((p: any) => ({ id: p.id, label: String(p.label || '').slice(0, 80), url: p.url }))
      : []
    const state: Record<string, WatchState> = {}
    for (const [k, v] of Object.entries((raw?.state && typeof raw.state === 'object' ? raw.state : {}) as Record<string, any>)) {
      state[k] = {
        value: typeof v?.value === 'number' ? v.value : null,
        band: String(v?.band || ''),
        checkedAt: String(v?.checkedAt || ''),
        error: String(v?.error || ''),
        changedAt: String(v?.changedAt || ''),
      }
    }
    return { pages, state }
  } catch {
    return empty
  }
}

export function writeWatchFile(f: WatchFile, file = watchFilePath()): void {
  atomicWriteFileSync(file, JSON.stringify(f, null, 2))
}

/** A cim vizsgalata: csak https, csak engedett host. A hibauzenet emberi mondat (hu + en). */
export function validateWatchUrl(raw: string): { ok: true; url: string; kind: WatchKind } | { ok: false; hu: string; en: string } {
  let u: URL
  try { u = new URL(String(raw || '').trim()) } catch {
    return { ok: false, hu: 'Ez nem érvényes webcím. Másold be a teljes címet, https://-sel együtt.', en: 'This is not a valid web address. Paste the full address, including https://.' }
  }
  if (u.protocol !== 'https:') {
    return { ok: false, hu: 'Csak https:// címet fogadok el.', en: 'Only https:// addresses are accepted.' }
  }
  const kind = hostKind(u.hostname)
  if (!kind) {
    return { ok: false, hu: 'Csak a Google Play (play.google.com) és az Apple App Store (apps.apple.com) oldalait tudom figyelni.', en: 'I can only watch pages on Google Play (play.google.com) and the Apple App Store (apps.apple.com).' }
  }
  return { ok: true, url: u.toString(), kind }
}

export function hostKind(host: string): WatchKind | null {
  const h = String(host || '').toLowerCase()
  if (h === 'play.google.com') return 'play'
  if (h === 'apps.apple.com') return 'apple'
  return null
}

function bandMin(band: string): number | null {
  const m = band.match(/^(\d[\d,.]*)\s*([KMB]?)\+?$/i)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const mult = { '': 1, K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'B']
  return Math.round(n * mult)
}

/**
 * A Google Play oldal HTML-jebol a letoltes-adat. `null`, ha az oldal nem ismerheto fel
 * (pl. megvaltozott a szerkezete): ilyenkor a hivo hibat jelez, NEM nullat.
 */
export function parsePlayPage(html: string): Reading | null {
  const m = html.match(/\["(\d[\d,.]*[KMB]?\+)",(\d+),(\d+),"\d[\d,.]*[KMB]?\+"\]/)
  if (m) {
    const exact = Number(m[3])
    return { kind: 'play', band: m[1], value: Number.isFinite(exact) && exact > 0 ? exact : Number(m[2]) }
  }
  const d = html.match(/<div class="[^"]*">(\d[\d,.]*[KMB]?\+)<\/div><div class="[^"]*">Downloads<\/div>/)
  if (d) return { kind: 'play', band: d[1], value: bandMin(d[1]) }
  return null
}

/** Az Apple oldal ertekeleseinek osszege (1-5 csillag darabszamai). `null`, ha nincs ilyen adat az oldalon. */
export function parseApplePage(html: string): Reading | null {
  const m = html.match(/"ratingCounts":\[(\d+(?:,\d+){0,9})\]/)
  if (!m) return null
  const sum = m[1].split(',').reduce((a, b) => a + Number(b), 0)
  return { kind: 'apple', band: '', value: sum }
}

export function parsePage(kind: WatchKind, html: string): Reading | null {
  return kind === 'play' ? parsePlayPage(html) : parseApplePage(html)
}

/** Emberi sor a felulet es az ertesites szamara. */
export function describeReading(kind: WatchKind, value: number | null, band: string, lang: 'hu' | 'en'): string {
  if (value === null) return lang === 'en' ? 'no reading yet' : 'még nincs mérés'
  if (kind === 'apple') return lang === 'en' ? `${value} ratings` : `${value} értékelés`
  const bandTxt = band ? (lang === 'en' ? ` (the page shows “${band}”)` : ` (az oldal „${band}” sávot mutat)`) : ''
  return lang === 'en' ? `${value} downloads${bandTxt}` : `${value} letöltés${bandTxt}`
}

export type Fetcher = (url: string) => Promise<string>

/** Az alap lekero: nyilvanos oldal, szerver-oldali, idozitessel. */
export const defaultFetcher: Fetcher = async (url) => {
  const resp = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'accept-language': 'en' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return await resp.text()
}

export interface CheckResult {
  id: string
  label: string
  kind: WatchKind
  ok: boolean
  /** Az elozo ertek (null: ez az elso meres). */
  previous: number | null
  current: number | null
  band: string
  increased: boolean
  error: string
}

/**
 * EGY oldal merese + az allapot frissitese. Az elso meres csak alapot rogzit (nem szol).
 * Sikertelen meres NEM irja felul az utolso jo erteket: csak a hibauzenet kerul az allapotba.
 */
export async function checkOne(page: WatchPage, state: WatchState | undefined, fetcher: Fetcher, now = new Date()): Promise<{ result: CheckResult; state: WatchState }> {
  const v = validateWatchUrl(page.url)
  const kind: WatchKind = v.ok ? v.kind : 'play'
  const prev = state || { value: null, band: '', checkedAt: '', error: '', changedAt: '' }
  const base = { id: page.id, label: page.label, kind, previous: prev.value, band: prev.band }
  try {
    if (!v.ok) throw new Error(v.en)
    const html = await fetcher(v.url)
    const r = parsePage(kind, html)
    if (!r) throw new Error('The page did not contain the expected data (its layout may have changed).')
    const increased = prev.value !== null && r.value !== null && r.value > prev.value
    const changed = prev.value === null || r.value !== prev.value
    const next: WatchState = {
      value: r.value, band: r.band, checkedAt: now.toISOString(), error: '',
      changedAt: changed ? now.toISOString() : prev.changedAt,
    }
    return { result: { ...base, ok: true, current: r.value, band: r.band, increased, error: '' }, state: next }
  } catch (err: any) {
    const msg = String(err?.message || err).slice(0, 200)
    return { result: { ...base, ok: false, current: prev.value, increased: false, error: msg }, state: { ...prev, checkedAt: now.toISOString(), error: msg } }
  }
}

/** Minden figyelt oldal merese; az ertekek MAGASABBRA ugrasanal `notify` kap egy magyar uzenetet. */
export async function runWatch(opts: {
  fetcher?: Fetcher
  notify?: (text: string) => Promise<void>
  file?: string
  now?: Date
  lang?: 'hu' | 'en'
} = {}): Promise<CheckResult[]> {
  const lang = opts.lang ?? 'hu'
  const file = opts.file ?? watchFilePath()
  const data = readWatchFile(file)
  const results: CheckResult[] = []
  const lines: string[] = []
  for (const p of data.pages) {
    const { result, state } = await checkOne(p, data.state[p.id], opts.fetcher ?? defaultFetcher, opts.now)
    data.state[p.id] = state
    results.push(result)
    if (result.increased) {
      lines.push(`${p.label || p.url}: ${describeReading(result.kind, result.previous, '', lang)} → ${describeReading(result.kind, result.current, result.band, lang)}`)
    }
  }
  writeWatchFile(data, file)
  if (lines.length && opts.notify) await opts.notify((lang === 'en' ? 'Download watcher: a number went up.\n' : 'Letöltés-figyelő: nőtt a szám.\n') + lines.join('\n'))
  return results
}
