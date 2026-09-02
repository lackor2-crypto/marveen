// AZ ONELLENORZES SORA ODA VIGYEN, AHOL A DOLOG LATSZIK.
//
// Boss, 2026-09-02: "de a fiok oldalra visz ahol semmit nem latok hogy hol
// vagyok mit kellene csinalni. [...] fiok oldalaon nem latok semmit pirossal
// szurkevel hogy hol kellne javitani barmit is. [...] szoval nem tiszta nekem
// hogy mit es hol kell csinalni."
//
// Ez a fajl a VISZONYOKAT meri, nem a forrast olvassa: aki a nevet KIIRJA
// (`_accHubMcpServerHtml` -> `data-mcp-server`) es aki a nevet KERESI
// (`_findMcpConnRow`), az ugyanarrol a nevrol beszeljen. Ket kulon helyen allo
// helyes kod meg lehet egymassal ellentetes -- pontosan ez a fajta hiba tud 75
// zold teszt mellett is atmenni.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dirname, '..', '..')
const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  let i = src.indexOf('(', start.index)
  let paren = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++
    else if (src[i] === ')') { paren--; if (paren === 0) { i++; break } }
  }
  let depth = 0
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start.index, j + 1) }
  }
  throw new Error(`nem zarodik be: ${name}`)
}

// A sablon-fuggvenyek stubjai. Szandekosan a LEHETO legbutabbak: ha a teszt
// egy valodi escape-elesre tamaszkodna, akkor a sajat stubjat merne.
const stubs = {
  escapeHtml: (s: unknown) => String(s === null || s === undefined ? '' : s),
  escapeAttr: (s: unknown) => String(s === null || s === undefined ? '' : s).replace(/"/g, '&quot;'),
  t: (k: string) => k,
  _connLabel: (n: string) => n,
  _connWhat: () => null,
}

function makeRowHtml(name: string, fix = 'agent-managed', status = 'failed'): string {
  const fn = new Function(
    'escapeHtml', 'escapeAttr', 't', '_connLabel', '_connWhat',
    extractFn(app, '_accHubMcpServerHtml') + '; return _accHubMcpServerHtml',
  )(stubs.escapeHtml, stubs.escapeAttr, stubs.t, stubs._connLabel, stubs._connWhat)
  return fn({ accountId: 'lackor3' }, { name, status, fix, reason: null })
}

/** Amit a sor kiirt, azt egy MINIMALIS DOM-ba tesszuk vissza: a keresonek
 *  pontosan ezt kell megtalalnia. Nem HTML-t parszolunk, hanem azt a mezot
 *  emeljuk ki, amit a bongeszo is `dataset.mcpServer`-kent latna. */
function fakeDomFrom(htmlDarabok: string[]): { querySelectorAll: (sel: string) => Array<{ dataset: { mcpServer: string } }> } {
  const elemek = htmlDarabok.map((h) => {
    const m = /data-mcp-server="([^"]*)"/.exec(h)
    if (!m) throw new Error('a sor nem irt ki data-mcp-server attributumot: ' + h.slice(0, 120))
    return { dataset: { mcpServer: m[1] } }
  })
  return { querySelectorAll: (sel: string) => (sel.includes('data-mcp-server') ? elemek : []) }
}

function makeFinder(dom: ReturnType<typeof fakeDomFrom>) {
  return new Function(
    'document',
    extractFn(app, '_mcpNameKey') + '\n' + extractFn(app, '_findMcpConnRow') + '\n; return _findMcpConnRow',
  )(dom) as (names: string[]) => { dataset: { mcpServer: string } } | null
}

describe('az MCP-sor kattintasi celja: a kiiro es a kereso ugyanarrol beszel', () => {
  it('a kapcsolat-sor KIIRJA a nyers szervernevet', () => {
    expect(makeRowHtml('plugin:telegram:telegram')).toContain('data-mcp-server="plugin:telegram:telegram"')
  })

  it('a kereso MEG IS TALALJA azt, amit a kiiro kiirt', () => {
    const dom = fakeDomFrom([makeRowHtml('drive'), makeRowHtml('plugin:notion:notion'), makeRowHtml('jira')])
    const talalt = makeFinder(dom)(['plugin:notion:notion'])
    expect(talalt?.dataset.mcpServer).toBe('plugin:notion:notion')
  })

  it('...es NEM talal olyat, ami nincs ott (a teszt nem mindenre bolint)', () => {
    const dom = fakeDomFrom([makeRowHtml('drive')])
    expect(makeFinder(dom)(['jira'])).toBeNull()
    expect(makeFinder(dom)([])).toBeNull()
  })

  // A szerver a nevet megszurve kuldi (tisztaNev: 40 karakter, szukitett
  // keszlet). Ha a kereso a NYERS nevvel hasonlitana, egy hosszu nev eseten a
  // kiemeles neman elmaradna -- es a felhasznalo megint csak nezne a lapot.
  it('a szerver altal MEGVAGOTT nevvel is talal', () => {
    const hosszu = 'plugin:' + 'x'.repeat(60)
    const vagott = hosszu.slice(0, 40)
    const dom = fakeDomFrom([makeRowHtml(hosszu)])
    expect(makeFinder(dom)([vagott])?.dataset.mcpServer).toBe(hosszu)
  })
})

// A `"` egy HTML-attributum belsejeben lezarja az attributumot. Az onclick
// eppen oda kerul, ezert a nevnek `&quot;`-kent kell atmennie -- kulonben a
// kattintas nem hibauzenetet ad, hanem CSENDBEN nem csinal semmit.
describe('a kattintas tenylegesen a megnevezett kapcsolatra ugrik', () => {
  const NEV = 'plugin:notion:notion'

  // Az onclick-kifejezest a FORRASBOL vesszuk ki es FUTTATJUK -- nem ujrairjuk.
  const kifejezes = /jumpToMcpConnector\(\$\{[^}]*\}\)`/.exec(app)
  const itemHtmlSrc = (() => {
    const kezd = app.indexOf('const itemHtml = (r, tone) =>')
    const veg = app.indexOf('\n\n  const paint', kezd)
    return kezd >= 0 && veg > kezd ? app.slice(kezd + 'const itemHtml = '.length, veg) : ''
  })()

  it('a forrasbol kiemelt reszek megvannak (kulonben ez a teszt vakon zoldulne)', () => {
    expect(kifejezes, 'nincs meg a jumpToMcpConnector(...) kifejezes').toBeTruthy()
    expect(itemHtmlSrc, 'nincs meg az itemHtml sablon').not.toBe('')
  })

  it('a nev EPSEGBEN erkezik meg a jumpToMcpConnector-hoz', () => {
    const onclick = new Function('glNames', 'return `' + kifejezes![0])(NEV) as string
    const itemHtml = new Function('escapeHtml', 'return ' + itemHtmlSrc)(stubs.escapeHtml) as
      (r: Record<string, unknown>, tone: Record<string, string>) => string
    const html = itemHtml(
      { label: 'x', desc: 'y', onclick, guide: null },
      { itemBg: '', fg: '', descFg: '' },
    )
    const attr = /onclick="([^"]*)"/.exec(html)
    expect(attr, 'az onclick attributum elszallt -- valoszinuleg egy nyers " zarta le').toBeTruthy()

    // Amit a bongeszo tenylegesen lefuttatna: az attributum HTML-dekodolva.
    const kod = attr![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    let kapott: string | null = null
    new Function('jumpToMcpConnector', 'switchPage', kod)(
      (n: string) => { kapott = n },
      () => { /* ide nem szabad eljutni */ },
    )
    expect(kapott).toBe(NEV)
  })

  it('tobb nev eseten mindegyik atmegy, vesszovel', () => {
    const onclick = new Function('glNames', 'return `' + kifejezes![0])('drive, jira') as string
    const kod = onclick.replace(/&quot;/g, '"')
    let kapott: string | null = null
    new Function('jumpToMcpConnector', kod)((n: string) => { kapott = n })
    expect(kapott).toBe('drive, jira')
  })
})
