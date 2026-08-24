// A kod-hid kartyaja ket KULONBOZO kerdesre valaszolt egymas alatt, es a ketto
// ellentmondasnak latszott (Boss, 2026-08-24):
//
//   "Nincs nyitott beszelgetes ebben a mappaban."
//   "kontextus: 108k token"
//
//   -> "hiszen ha nincs beszelgetes akor nem kellene lennie tokennek sem"
//
// Nem ellentmondas volt: a ful-lista azt mutatja, mi van EPPEN NYITVA a VS
// Code-ban (a worker `live` merese), a token pedig a mappahoz KOTOTT beszelgetes
// naplojabol jon, ami a lemezen marad a ful bezarasa utan is. A magyarazat
// viszont csak a tooltipben allt -- a kartya fo szovege hallgatott rola.
//
// Ez ugyanaz a hibafajta, mint a "nulla ket dolgot jelenthet": a felulet ket
// allitast tesz egymas melle anelkul, hogy feloldana. Ezert HAROM allapot van,
// mindharomnak sajat, a KOVETKEZO LEPEST mondo mondattal.
//
// web/app.js klasszikus szkript, nincs modul-hatara, ezert a tiszta segedeket
// zarojel-parositassal emeljuk ki es futtatjuk (az accounts-one-panel.test.ts
// idiomaja) -- igy a teszt a VISELKEDEST meri, nem a forras szoveget.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

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

interface Tab { sessionId?: string; title?: string | null; live?: boolean | null; contextTokens?: number | null; mtime?: number | null }
interface Entry { tabs?: Tab[]; tabsReason?: string; contextTokens?: number | null }

// A `t()` a KULCSOT adja vissza a behelyettesitett tokenekkel, hogy lassuk,
// melyik uzenet sult el es mi keruelt bele. A valodi szovegek meglete kulon
// allitas (lentebb), mindket nyelven.
const harness = `
  function t(key, vars) {
    if (!vars) return key
    return key + '|' + Object.keys(vars).map(function (k) { return k + '=' + vars[k] }).join(',')
  }
  function escapeHtml(s) { return String(s) }
  function escapeAttr(s) { return String(s) }
  ${extractFn(app, 'cbFmtKTokens')}
  ${extractFn(app, 'cbHasTabRows')}
  ${extractFn(app, 'cbTabsEmptyHasCtx')}
  ${extractFn(app, 'cbTabsPickHtml')}
  return { cbTabsPickHtml: cbTabsPickHtml, cbTabsEmptyHasCtx: cbTabsEmptyHasCtx, cbFmtKTokens: cbFmtKTokens }
`
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const api = new Function(harness)() as {
  cbTabsPickHtml: (e: Entry) => string
  cbTabsEmptyHasCtx: (e: Entry) => boolean
  cbFmtKTokens: (n: number) => string
}

describe('ures ful-lista + mert kontextus: a kartya nem mond ket dolgot egyszerre', () => {
  it('a munkas latja, hogy nincs nyitva, DE van naplo -> kimondja a tokent is', () => {
    const html = api.cbTabsPickHtml({ tabs: [], tabsReason: 'ok', contextTokens: 108_000 })
    expect(html).toContain('cb.card.tabs_none_ctx|n=108')
    // A regi, hallgatag mondat NEM jelenhet meg ilyenkor.
    expect(html).not.toContain('cb.card.tabs_none|')
    expect(html).not.toMatch(/cb\.card\.tabs_none"/)
    // A tooltip a NYERS tokenszamot mondja, ahogy a tobbi kontextus-sugo is.
    expect(html).toContain('cb.card.tabs_none_ctx_help|n=108000')
  })

  it('a munkas latja, hogy nincs nyitva, es nincs naplo -> a regi mondat marad', () => {
    const html = api.cbTabsPickHtml({ tabs: [], tabsReason: 'empty', contextTokens: null })
    expect(html).toContain('cb.card.tabs_none')
    expect(html).not.toContain('tabs_none_ctx')
  })

  it('nem latunk oda (a munkas nem jelentkezett) -> a token SEM valtoztat rajta', () => {
    // Ez a lenyeg: mert kontextus mellett sem allithatjuk, hogy "nincs nyitva",
    // ha egyszer nem lattunk oda. A nulla ket dolgot jelenthet.
    const html = api.cbTabsPickHtml({ tabs: [], tabsReason: 'stale', contextTokens: 108_000 })
    expect(html).toContain('cb.card.tabs_blind')
    expect(html).not.toContain('tabs_none')
  })

  it('a 0 token nem meres, hanem hianyzo adat -> nem allunk elo szammal', () => {
    expect(api.cbTabsEmptyHasCtx({ tabs: [], tabsReason: 'ok', contextTokens: 0 })).toBe(false)
    const html = api.cbTabsPickHtml({ tabs: [], tabsReason: 'ok', contextTokens: 0 })
    expect(html).not.toContain('tabs_none_ctx')
  })

  it('ha van elo ful, az ures-ag egyaltalan nem fut', () => {
    const e: Entry = { tabs: [{ sessionId: 'abcdef12', title: 'csv elemzes', live: true, contextTokens: 73_000 }], tabsReason: 'ok', contextTokens: 73_000 }
    expect(api.cbTabsEmptyHasCtx(e)).toBe(false)
    const html = api.cbTabsPickHtml(e)
    expect(html).not.toContain('tabs_none')
    expect(html).not.toContain('tabs_blind')
  })

  it('a bezart ful (live === false) nem szamit elo fulnek', () => {
    const e: Entry = { tabs: [{ sessionId: 'abcdef12', live: false, contextTokens: 108_000 }], tabsReason: 'ok', contextTokens: 108_000 }
    expect(api.cbTabsEmptyHasCtx(e)).toBe(true)
    expect(api.cbTabsPickHtml(e)).toContain('cb.card.tabs_none_ctx|n=108')
  })
})

describe('a token-szam egy helyen formazodik', () => {
  it('10k folott egesz, alatta egy tizedes, magyar tizedesvesszovel', () => {
    expect(api.cbFmtKTokens(108_000)).toBe('108')
    expect(api.cbFmtKTokens(73_000)).toBe('73')
    expect(api.cbFmtKTokens(7_300)).toBe('7,3')
  })

  it('a keplet PONTOSAN egyszer szerepel: a helper torzseben', () => {
    // Nem a keplet tiltott, hanem az ISMETLESE -- kulonben ket alakban allna
    // ugyanaz a szam a kartyan. Ezert szamolunk, nem tiltunk.
    const hits = app.match(/\/ 1000\)\.toFixed/g) || []
    expect(hits.length, 'a token-formazas tobb helyen van kezzel leirva').toBe(1)
    expect(extractFn(app, 'cbFmtKTokens')).toContain('/ 1000).toFixed')
    expect(app).not.toContain('(tb.contextTokens / 1000).toFixed')
  })
})

describe('a szoveg mindket nyelven megvan', () => {
  for (const key of ['cb.card.tabs_none_ctx', 'cb.card.tabs_none_ctx_help']) {
    it(`${key} hu + en`, () => {
      expect(hu, `hu: ${key}`).toContain(`'${key}':`)
      expect(en, `en: ${key}`).toContain(`'${key}':`)
    })
  }

  it('a sugo a KOVETKEZO LEPEST mondja, nem csak a tenyt', () => {
    const line = /'cb\.card\.tabs_none_ctx_help':\s*'([^']*)'/.exec(hu)
    expect(line, 'nincs meg a hu sugo').not.toBeNull()
    expect(line![1]).toMatch(/VS Code/)
  })
})

describe('a kulon kontextus-sor nem ismetli meg a szamot', () => {
  it('a kartya csak akkor rakja ki, ha az ures-ag nem mondta el', () => {
    expect(app).toContain('!cbHasTabRows(e) && !cbTabsEmptyHasCtx(e) ? cbContextRowHtml(e)')
  })
})
