// A Jovahagyasok oldal ellenorzes-inditó popovere KETSZER kerult a kepernyo ala
// ugyanazzal a vegkimenettel (Boss): 2026-08-10 -- "a jovahagyasok ellenorzes-
// gombja a kepernyon kivul" (ezt rogziti a mobile-parity-check skill is), es
// 2026-09-06 -- "nem lehet kattintani az ellenorzes inditasat, nem is lehet
// gorgetni". Az elso javitas (flip-up) BENT VOLT, megis megismetlodott, mert a
// javitas a MAGASSAGOT merte rosszul:
//
//   - `maxHeight = ''` csak az inline erteket torli, a stilluslap 320px-es
//     plafonja marad -> a mert magassag kisebb a valodinal;
//   - felfele nyitaskor a TETEJET szamoltuk ebbol az alulmert ertekbol, a
//     max-height-et viszont egy nagyobb szamra allitottuk -> a doboz lejjebb
//     ert, mint amennyi helyet feltetelezett.
//
// Ezert ez a teszt NEM a forras szoveget nezi, hanem VEGIGMERI a geometriat:
// minden horgony-pozicioban, tobb ablakmeretben es tobb tartalom-magassagnal a
// popovernek a kepernyon BELUL kell maradnia -- kulonben az utolso sora, a
// cselekvo gomb, megint elerhetetlen lesz. A `position: fixed` miatt a lap
// gorgetese nem menti meg: ami kilog, az elveszett.
//
// web/app.js klasszikus szkript, nincs modul-hatara, ezert a fuggvenyt
// zarojel-parositassal emeljuk ki es futtatjuk (a code-tabs-empty-but-context
// es az accounts-one-panel tesztek idiomaja).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const css = readFileSync(join(WEB, 'style.css'), 'utf8')

/** A stilluslap plafonja a popoveren -- a mereshiba forrasa volt. */
const CSS_MAX_HEIGHT = 320

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() nincs a web/app.js-ben`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() zarojelei nincsenek parban`)
}

interface Style { [k: string]: string }
interface Rect { top: number; bottom: number; left: number; width: number; height: number }

/**
 * A popover ugy viselkedik, mint a bongeszoben: az `offsetHeight` a TARTALOM
 * magassaga, a hatalyos max-height-tel levagva -- es a hatalyos ertek `''`
 * eseten a STILLUSLAPE, nem a vegtelen. Pontosan ez a kulonbseg tunt el a
 * regi kodban.
 */
function makePop(contentHeight: number) {
  const style: Style = {}
  return {
    style,
    offsetWidth: 240,
    get offsetHeight(): number {
      const mh = style.maxHeight
      if (mh === 'none') return contentHeight
      if (!mh) return Math.min(contentHeight, CSS_MAX_HEIGHT)
      return Math.min(contentHeight, parseFloat(mh))
    },
  }
}

/** A vegleges doboz felso/also ele a beallitott top/bottom/max-height alapjan. */
function renderedBox(style: Style, contentHeight: number, innerHeight: number) {
  const cap = style.maxHeight && style.maxHeight !== 'none' ? parseFloat(style.maxHeight) : Infinity
  const hasTop = !!style.top
  const hasBottom = !!style.bottom
  if (hasTop && hasBottom) {
    const top = parseFloat(style.top)
    const bottom = innerHeight - parseFloat(style.bottom)
    return { top, bottom, scrolls: contentHeight > bottom - top }
  }
  const height = Math.min(contentHeight, cap)
  if (hasBottom) {
    const bottom = innerHeight - parseFloat(style.bottom)
    return { top: bottom - height, bottom, scrolls: contentHeight > height }
  }
  const top = parseFloat(style.top)
  return { top, bottom: top + height, scrolls: contentHeight > height }
}

function place(opts: { anchorTop: number; innerHeight: number; innerWidth: number; contentHeight: number }) {
  const pop = makePop(opts.contentHeight)
  const rect: Rect = { top: opts.anchorTop, bottom: opts.anchorTop + 22, left: 120, width: 90, height: 22 }
  const anchor = { getBoundingClientRect: () => rect }
  const win = { innerHeight: opts.innerHeight, innerWidth: opts.innerWidth }
  const factory = new Function('ctx', `
    const { pop, anchor, win } = ctx
    const window = win
    let _verifyPickerPopover = pop
    const _currentVerifyAnchor = () => anchor
    ${extractFn(app, '_placeVerifyPicker')}
    return _placeVerifyPicker
  `) as (ctx: unknown) => () => void
  factory({ pop, anchor, win })()
  return { style: pop.style, box: renderedBox(pop.style, opts.contentHeight, opts.innerHeight) }
}

describe('Jovahagyasok: az ellenorzes-indito popover nem lophat ki a kepernyorol', () => {
  // A mert eset: alacsony horgony (a lap also feleben) + a stilluslap
  // plafonjanal MAGASABB tartalom. A regi kod itt logott ki alul.
  it('alacsony horgony + magas tartalom eseten a doboz alja a kepernyon belul marad', () => {
    const { box } = place({ anchorTop: 680, innerHeight: 760, innerWidth: 1440, contentHeight: 420 })
    expect(box.bottom).toBeLessThanOrEqual(760)
    expect(box.top).toBeGreaterThanOrEqual(0)
  })

  it('a magassagot a stilluslap plafonja NELKUL meri (maxHeight none, nem ures sztring)', () => {
    // Ha valaki visszairja a `''`-t, a meres ujra 320-nal all meg, es a
    // pozicionalas megint alulmeri a dobozt.
    expect(extractFn(app, '_placeVerifyPicker')).toContain("maxHeight = 'none'")
  })

  it('felfele nyitaskor az ALSO elt rogziti, nem a tetejet szamolja', () => {
    const { style } = place({ anchorTop: 680, innerHeight: 760, innerWidth: 1440, contentHeight: 420 })
    expect(style.bottom).toBeTruthy()
    expect(style.top).toBeFalsy()
  })

  it('magas horgonynal lefele nyit, es ott sem log ki', () => {
    const { style, box } = place({ anchorTop: 40, innerHeight: 760, innerWidth: 1440, contentHeight: 420 })
    expect(style.top).toBeTruthy()
    expect(style.bottom).toBeFalsy()
    expect(box.bottom).toBeLessThanOrEqual(760)
  })

  it('alacsony ablakban (egyik oldalon sincs hely) mindket elhez feszul es gorget', () => {
    const { style, box } = place({ anchorTop: 150, innerHeight: 340, innerWidth: 1440, contentHeight: 420 })
    expect(style.top).toBeTruthy()
    expect(style.bottom).toBeTruthy()
    expect(box.top).toBeGreaterThanOrEqual(0)
    expect(box.bottom).toBeLessThanOrEqual(340)
    expect(box.scrolls).toBe(true)
  })

  it('nem elrendezett (0x0) horgonynal nem szamol nullakbol -- nem nyul a pozicióhoz', () => {
    const pop = makePop(420)
    const anchor = { getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, width: 0, height: 0 }) }
    const factory = new Function('ctx', `
      const { pop, anchor, win } = ctx
      const window = win
      let _verifyPickerPopover = pop
      const _currentVerifyAnchor = () => anchor
      ${extractFn(app, '_placeVerifyPicker')}
      return _placeVerifyPicker
    `) as (ctx: unknown) => () => void
    factory({ pop, anchor, win: { innerHeight: 760, innerWidth: 1440 } })()
    expect(pop.style.top).toBeUndefined()
    expect(pop.style.bottom).toBeUndefined()
  })

  // A LENYEG: nem egy-ket kivalasztott pontot nezunk, hanem VEGIGSEPERJUK a
  // horgony minden lehetseges fuggoleges helyzetet, tobb ablakmeretben es tobb
  // tartalom-magassagnal. Egy pozicio-hiba igy nem tud atcsuszni azzal, hogy a
  // teszt eppen nem arra a pixelre kerdezett ra.
  it('BARMELY horgony-pozicioban, barmely ablakmeretben a doboz a kepernyon belul van', () => {
    const viewports = [
      { innerWidth: 1440, innerHeight: 900 }, // asztali
      { innerWidth: 1280, innerHeight: 760 }, // laptop
      { innerWidth: 390, innerHeight: 844 },  // telefon (mobile-parity-check)
      { innerWidth: 844, innerHeight: 390 },  // telefon fekvo -- itt a legszukebb
    ]
    const contents = [120, 240, 320, 420, 600]
    const bad: string[] = []
    for (const vp of viewports) {
      for (const contentHeight of contents) {
        for (let anchorTop = 0; anchorTop + 22 <= vp.innerHeight; anchorTop += 10) {
          const { box } = place({ anchorTop, contentHeight, ...vp })
          if (box.top < 0 || box.bottom > vp.innerHeight) {
            bad.push(`${vp.innerWidth}x${vp.innerHeight} horgony=${anchorTop} tartalom=${contentHeight}`
              + ` -> doboz ${box.top.toFixed(0)}..${box.bottom.toFixed(0)}`)
          }
        }
      }
    }
    expect(bad.slice(0, 5), `${bad.length} pozicioban logott ki a doboz`).toEqual([])
  })

  it('az indito gomb a gorgeto dobozban is a lathato also elen marad (sticky)', () => {
    const rule = css.slice(css.indexOf('.verify-picker-popover #verifyPickerGo'))
    expect(rule.slice(0, 200)).toMatch(/position:\s*sticky/)
    // A hatteret NEM allitja at: a .btn-primary mar opak, egy sajat szin itt
    // csendben elszinezne a gombot.
    expect(rule.slice(0, rule.indexOf('}'))).not.toMatch(/background:/)
  })

  it('a popover keskeny kepernyon sem szelesebb a viewportnal', () => {
    const block = css.slice(css.indexOf('.verify-picker-popover {'))
    expect(block.slice(0, block.indexOf('}'))).toMatch(/width:\s*min\(240px,\s*calc\(100vw/)
  })
})
