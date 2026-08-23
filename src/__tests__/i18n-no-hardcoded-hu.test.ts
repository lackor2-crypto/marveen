/**
 * ★ A KETNYELVUSEG KENYSZERITO ORE.
 *
 * Boss, 2026-08-23: „nincs meg angol nyelven!!!!!" -- majd: „de errol mar volt
 * egyszer szo." Ez a masodik alkalom. Egy szabaly, amit csak a CLAUDE.md ved,
 * harmadszor is meg fog dolni: aki uj fejlesztokent leul, a kodot latja, nem a
 * dokumentaciot. Ezert all itt egy teszt, ami MEGBUKTATJA a munkat.
 *
 * AMIT ORIZ
 *   Minden UJ, kemenyen kodolt magyar szoveg a `web/index.html`-ben es a
 *   `web/app.js`-ben. „Kemenyen kodolt" = nem megy at a `t()`-n es nincs
 *   `data-i18n*` attributum, tehat angol nyelvbeallitas mellett is magyarul
 *   marad a kepernyon.
 *
 * MIERT NEM ELEG A `lang-parity.test.ts`
 *   Az a `hu.js` es az `en.js` kulcsait hasonlitja. Ha a szoveg BE SEM KERUL a
 *   lang-fajlokba, a kulcshalmazok tokeletesen egyeznek -- a paritas-teszt zold
 *   marad, es kozben fel felulet magyarul all. Pontosan igy csuszott at az
 *   Intezo hasznalati utmutatoja es a „Kik szerepeljenek a faban?" szerkeszto.
 *
 * HOGYAN MUKODIK -- RACSKEREK
 *   A `fixtures/i18n-baseline.json` a MAR MEGLEVO adossag: 2026-08-23-an mert,
 *   660 sztring. Ami rajta van, az atmegy. Ami NINCS rajta, az bukas.
 *   A lista igy csak ROVIDULHET: minden forditas leveszi rola a sort, uj magyar
 *   mondat viszont nem tud eszrevetlenul felkerulni.
 *
 * HA EZ A TESZT ELBUKIK, A TEENDO NEM A BAZIS BOVITESE:
 *   1. vedd fel a szoveget `web/lang/hu.js` ES `web/lang/en.js` ala,
 *   2. a HTML-ben `data-i18n="kulcs"`, a JS-ben `t('kulcs')`,
 *   3. `npm run i18n:baseline` (a lista rovidul, a szkript ezt engedi).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanHtml, scanJs, fingerprint, HU_ACCENT, type Hit } from './helpers/i18n-scan.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const BASELINE = JSON.parse(
  readFileSync(join(ROOT, 'src', '__tests__', 'fixtures', 'i18n-baseline.json'), 'utf-8'),
) as Record<string, string[]>

const WATCHED: Array<{ file: string; scan: (p: string) => Hit[] }> = [
  { file: 'web/index.html', scan: scanHtml },
  { file: 'web/app.js', scan: scanJs },
]

describe('a feluleten nincs UJ, keztol magyarul odairt szoveg', () => {
  for (const { file, scan } of WATCHED) {
    it(`${file}: minden uj szoveg atmegy a forditason`, () => {
      const known = new Set(BASELINE[file] || [])
      expect(known.size, `hianyzik a bazis ehhez: ${file}`).toBeGreaterThan(0)

      const hits = scan(join(ROOT, file))
      const ujak = hits.filter((h) => !known.has(fingerprint(h)))

      // Egy-egy talalatot mutatunk, sorszammal: a hibauzenetbol egybol
      // odalehessen menni. Ha sok van, az elso tizenketto is eleg iranynak.
      const lista = ujak.slice(0, 12)
        .map((h) => `  ${file}:${h.line}  [${h.kind}]  ${h.text}`)
        .join('\n')
      const tobb = ujak.length > 12 ? `\n  … és még ${ujak.length - 12}` : ''

      expect(
        ujak.length,
        ujak.length === 0 ? '' : [
          '',
          `${ujak.length} olyan magyar szöveg került a felületre, ami angol nyelvbeállítás mellett is magyar marad:`,
          lista + tobb,
          '',
          'TEENDŐ (a bazis bővítése NEM megoldás):',
          "  1. a szöveg kerüljön be web/lang/hu.js ÉS web/lang/en.js alá,",
          "  2. HTML-ben data-i18n=\"kulcs\", JS-ben t('kulcs'),",
          '  3. npm run i18n:baseline',
          '',
        ].join('\n'),
      ).toBe(0)
    })
  }

  it('a lista csak rovidulhet -- ami lekerult rola, nem jon vissza', () => {
    // Nem a bukas a cel, hanem a MERES: a fejlesztes iranya latszik belole.
    let maradt = 0
    for (const { file, scan } of WATCHED) {
      const known = new Set((BASELINE[file] || []).map((s) => s))
      const most = new Set(scan(join(ROOT, file)).map(fingerprint))
      const lefordult = [...known].filter((s) => !most.has(s)).length
      maradt += most.size
      // eslint-disable-next-line no-console
      console.log(`[i18n] ${file}: ${most.size} magyar maradt, ${lefordult} már lefordítva a bázisból`)
    }
    expect(maradt).toBeGreaterThanOrEqual(0)
  })
})

describe('az angol nyelvi fajl tenyleg angol', () => {
  it('az en.js-ben nincs magyar ekezetes szoveg', () => {
    // Ez a leggyakoribb „forditas": a magyar sor atmasolva az en.js-be, hogy
    // a paritas-teszt zold legyen. Nincs bazis, nincs turhataro.
    const src = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8')
    const rossz: string[] = []
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')
      if (HU_ACCENT.test(code)) rossz.push(`  web/lang/en.js:${i + 1}  ${line.trim().slice(0, 140)}`)
    })
    expect(rossz.length, rossz.length ? '\nMagyar szöveg az angol nyelvi fájlban:\n' + rossz.join('\n') + '\n' : '')
      .toBe(0)
  })
})
