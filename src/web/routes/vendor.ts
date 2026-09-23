/**
 * HARMADIK FELES BONGESZO-ESZKOZOK KISZOLGALASA (kanban f7d423e7).
 *
 * Ma egyetlen ilyen eszkoz van: a `pdfjs-dist` (PDF-nezegeto). A tulajdonos kerte,
 * hogy a Munkapad PDF-elonezete ne a bongeszo sajat nezegetojere bizza magat,
 * hanem MINDEN bongeszoben ugyanaz a nezet legyen.
 *
 * MIERT NEM CDN-ROL: egy frissen telepitett, halozat nelkuli gepen a CDN-es
 * megoldas uresen hagyna az elonezetet, es a hiba OKA sem latszana. Ezert a
 * fajlok a csomagbol, a sajat kiszolgalonkrol jonnek.
 *
 * A NULLA KET DOLGOT JELENTHET. Ha a fajl nincs meg, az lehet
 *   - "nincs telepitve a csomag" (nem futott `npm install`)  -> ezt KIMONDJUK,
 *     a potlo paranccsal egyutt, ember altal olvashato mondatban;
 *   - "rossz utat kertek"                                    -> sima 404.
 * A ketto KULON valasz: a bongeszo-oldal a 404 torzsebol olvassa ki az okot,
 * es nem talalgat.
 */
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { serveFile } from '../http-helpers.js'
import { PROJECT_ROOT } from '../../config.js'
import type { RouteContext } from './types.js'

/** A csomag neve -- egy helyen, hogy az uzenet es az ut ne csuszhasson szet. */
export const PDFJS_PACKAGE = 'pdfjs-dist'

/** A KISZOLGALHATO ket fajl a `build/` alatt. Szandekosan tetelesen, nem
 *  mintaval: a `build/` mappaban ott van a terkep-fajl (`.map`, tobb MB) es a
 *  `pdf.sandbox.mjs` is, amire nincs szuksegunk. */
const BUILD_FILES = new Set(['pdf.min.mjs', 'pdf.worker.min.mjs'])

/** Azok a mappak, amikbol a pdf.js MENET KOZBEN tolt be adatot (karakterkeszlet-
 *  terkepek, beepitett betutipusok, szinprofilok, wasm-dekoderek). Enelkul a
 *  keleti karakterek es a beagyazatlan betutipusok helyen ures folt lenne. */
const ASSET_DIRS = ['cmaps/', 'standard_fonts/', 'wasm/', 'iccs/']

/** Amit ezekbol a mappakbol kiadunk. Minden mas (pl. `.map`) kimarad. */
const ASSET_EXTS = new Set(['.bcmap', '.pfb', '.ttf', '.otf', '.wasm', '.icc', '.js'])

/**
 * A kert alut a csomagon BELULI valodi fajlutra fordítja, vagy `null`-t ad, ha
 * a kerest nem szabad kiszolgalni.
 *
 * Tiszta fuggveny (nem nez fajlrendszert), hogy a szabaly onmagaban
 * bizonyithato legyen: a `..`, a perjellel kezdodo ut es a visszaperjel
 * (Windows-os utvonal-trukk) mind elutasitva, meg mielott barmit megnyitnank.
 */
export function resolvePdfjsAsset(subPath: string): string | null {
  if (!subPath || subPath.length > 200) return null
  if (subPath.includes('..') || subPath.includes('\\') || subPath.startsWith('/')) return null
  if (subPath.includes('\0')) return null
  if (subPath.startsWith('build/')) {
    const file = subPath.slice('build/'.length)
    if (!BUILD_FILES.has(file)) return null
    return `build/${file}`
  }
  const dir = ASSET_DIRS.find((d) => subPath.startsWith(d))
  if (!dir) return null
  const rest = subPath.slice(dir.length)
  // Egy szint melyen allnak, alkonyvtar nincs: ha megis jonne, elutasitjuk.
  if (!rest || rest.includes('/')) return null
  if (!ASSET_EXTS.has(extname(rest).toLowerCase())) return null
  return `${dir}${rest}`
}

/** A csomag gyokere ezen a telepitesen. */
export function pdfjsRoot(): string {
  return join(PROJECT_ROOT, 'node_modules', PDFJS_PACKAGE)
}

/** Fent van-e a csomag. Magat a FORRAST kerdezzuk meg (letezik-e a belepesi
 *  pont), nem egy korabbi meresbol kovetkeztetunk. */
export function pdfjsInstalled(): boolean {
  return existsSync(join(pdfjsRoot(), 'build', 'pdf.min.mjs'))
}

/** A hianyzo csomagrol szolo mondat -- a felulet ezt mutatja meg valtoztatas
 *  nelkul, tehat itt NEM allhat gepi kod. */
export function pdfjsMissingMessage(lang: string): { message: string; detail: string } {
  return lang === 'en'
    ? {
      message: 'The PDF viewer is not installed on this machine, so the preview cannot be drawn.',
      detail: `Run \`npm install\` in the ${PROJECT_ROOT} folder (it installs the ${PDFJS_PACKAGE} package), then reload this page.`,
    }
    : {
      message: 'A PDF-nezegeto nincs telepitve ezen a gepen, ezert az elonezetet nem tudom kirajzolni.',
      detail: `Futtasd a \`npm install\` parancsot a ${PROJECT_ROOT} mappaban (ez teszi fel a ${PDFJS_PACKAGE} csomagot), utana toltsd ujra ezt az oldalt.`,
    }
}

/** A csomag FENT VAN, de egy menet kozbeni adatfajlja hianyzik (csonka vagy
 *  reszleges telepites). Mas a baj, tehat mas a mondat is: ide NEM illik a
 *  "nincs telepitve", mert az a felhasznalot rossz iranyba kuldene. */
export function pdfjsAssetMissingMessage(lang: string, what: string): { message: string; detail: string } {
  return lang === 'en'
    ? {
      message: 'The PDF viewer is installed, but one of its data files is missing.',
      detail: `Missing file: ${PDFJS_PACKAGE}/${what}. Reinstall the package with \`npm install\` in the ${PROJECT_ROOT} folder, then reload this page.`,
    }
    : {
      message: 'A PDF-nezegeto fent van, de az egyik adatfajlja hianyzik.',
      detail: `A hianyzo fajl: ${PDFJS_PACKAGE}/${what}. Telepitsd ujra a csomagot (\`npm install\` a ${PROJECT_ROOT} mappaban), utana toltsd ujra ezt az oldalt.`,
    }
}

const PREFIX = '/vendor/pdfjs/'

export function tryHandleVendor(ctx: RouteContext): boolean {
  const { req, res, path } = ctx
  if (!path.startsWith(PREFIX)) return false

  let sub: string
  try {
    sub = decodeURIComponent(path.slice(PREFIX.length))
  } catch {
    res.writeHead(400); res.end('Bad request'); return true
  }
  const rel = resolvePdfjsAsset(sub)
  if (!rel) { res.writeHead(404); res.end('Not found'); return true }

  const filePath = join(pdfjsRoot(), rel)
  if (!existsSync(filePath)) {
    // ITT valik el a ket nulla: nincs telepitve a csomag, vagy csak ez az
    // egy fajl nincs meg. A bongeszo-oldal ezt a torzset olvassa ki.
    const lang = ctx.url.searchParams.get('lang') === 'en' ? 'en' : 'hu'
    const body = pdfjsInstalled()
      ? { error: 'pdfjs_asset_missing', ...pdfjsAssetMissingMessage(lang, rel) }
      : { error: 'pdfjs_missing', ...pdfjsMissingMessage(lang) }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
    return true
  }
  // A csomag verziozott (a package-lock rogziti), a tartalma egy telepitesen
  // belul nem valtozik -- ezert hosszu gyorsitotar. A verziovaltas uj
  // fajltartalmat es uj ETag-et ad.
  serveFile(req, res, filePath, { cacheSeconds: 86400 })
  return true
}
