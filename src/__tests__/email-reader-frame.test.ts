// A levelolvaso keret MAGASSAGA -- azaz mennyi latszik a levelbol abban a
// pillanatban, amikor megerkezett.
//
// Boss, 2026-08-19 (a bejelentett fiok, The Home Depot hirlevel): "elsonek
// csak egy kicsike kis resze jelent meg. azt hittem mar nem tolti be
// rendesen. de aztan kesobb betoltotte."
//
// MERVE, ugyanaznap, ugyanazon a levelen:
//   - a szerver 0,16-0,22 mp alatt valaszolt (71 KB HTML, 0 melleklet),
//     tehat a levelbetoltes NEM volt lassu;
//   - a levelben 9 tavoli kep van, ebbol 4-en nincs magassag-attributum,
//     ketto pedig 1x1-es nyomkoveto pixel (open.homedepot.com,
//     trk.mg.homedepot.com);
//   - a keret `load` esemenye MINDEN alforrast megvar, igy az elso meres is
//     a nyomkoveto pixelekre vart; addig a keret a CSS min-height 80px-en ult.
//
// Amit ez a fajl ved: a meres NE varjon a kepekre, es amig kep tolt, a keret
// ne zsugorodjon sliverre -- de amint minden megjott, a PONTOS magassag
// jarjon, kulonben egy harom soros level all 700 px-es uresseg kozepen.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

function extractFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`nincs ilyen fuggveny: ${name}`)
  const start = { index: at }
  let depth = 0
  for (let j = src.indexOf('{', start.index); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start.index, j + 1) }
  }
  throw new Error(`nem zarodik: ${name}`)
}

const frameHeight = new Function(
  `${extractFn(app, 'emailBodyFrameHeight')} return emailBodyFrameHeight`,
)() as (measured: number, pending: boolean, floor: number) => number

describe('emailBodyFrameHeight', () => {
  it('meg toltodo kepeknel az olvasasi padlot tartja, nem a hamis merest', () => {
    // Ez a bejelentett eset: a mert 96 px a kepek NELKULI magassag.
    expect(frameHeight(96, true, 700)).toBe(700)
  })

  it('ha a mert magassag mar nagyobb a padlonal, a mert nyer', () => {
    expect(frameHeight(1400, true, 700)).toBe(1416)
  })

  it('ha minden kep megjott, a PONTOS magassag jar -- padlo nelkul', () => {
    // Kulonben egy rovid level allna a fel oszlopnyi uresseg kozepen.
    expect(frameHeight(96, false, 700)).toBe(112)
  })

  it('sosem ad negativ magassagot', () => {
    expect(frameHeight(-50, false, 0)).toBe(16)
  })
})

describe('a keret meg a kepek elott olvashato meretben all', () => {
  const fn = extractFn(app, 'renderEmailMessageBody')

  it('az elso meres NEM a keret `load` esemenyere var', () => {
    // A `load` minden alforrast megvar, koztuk a nyomkoveto pixeleket is --
    // pont ez volt a bejelentett keses.
    const poll = fn.indexOf('earlyPoll')
    expect(poll, 'nincs korai meres a renderEmailMessageBody-ban').toBeGreaterThanOrEqual(0)
    expect(fn.slice(poll)).toContain('readyState')
  })

  it('a korai meres KORLATOS -- nem terhet vissza a regi vegtelen atmeretezes', () => {
    // A korabbi ResizeObserver azert hurkolt, mert a keret sajat merete
    // valtotta ki a kovetkezo merest. Itt ido szabja meg, es le is all.
    expect(fn).toContain('clearInterval(earlyPoll)')
    expect(fn).toMatch(/setTimeout\(\(\) => clearInterval\(earlyPoll\), \d+\)/)
  })

  it('a padlo nem ragad be egy soha meg nem erkezo kep miatt', () => {
    // Egy nyomkoveto pixel, ami se nem tolt be, se nem hasal el, kulonben
    // orokre 700 px-en tartana egy harom soros levelet is.
    expect(fn).toContain('FLOOR_DEADLINE_MS')
    expect(fn).toMatch(/Date\.now\(\) - frameStartedAt > FLOOR_DEADLINE_MS/)
    expect(fn).toContain('setTimeout(sizeToContent, FLOOR_DEADLINE_MS')
  })
  it('a kepek mar a `load` ELOTT elkezdenek toltodni', () => {
    // A lusta (`loading="lazy"`) kepek egy 0 px-re osszecsukott keretben
    // sosem indulnanak el maguktol. Ha csak a keret `load`-jakor tesszuk oket
    // eagerre, a level leghosszabb resze indul a legkesobb -- ezert a korai
    // meres is meglokni oket, mielott merne.
    const eager = fn.indexOf('forceEagerImages')
    expect(eager, 'nincs eager-kapcsolas a renderEmailMessageBody-ban').toBeGreaterThanOrEqual(0)
    const poll = fn.indexOf('const earlyPoll')
    expect(fn.slice(poll)).toContain('forceEagerImages()')
    // ...es tenyleg a MERES elott, kulonben az elso meres meg 0 magas
    // kepekkel szamolna.
    const inPoll = fn.slice(poll)
    expect(inPoll.indexOf('forceEagerImages()')).toBeLessThan(inPoll.indexOf('sizeToContent()'))
  })
})
