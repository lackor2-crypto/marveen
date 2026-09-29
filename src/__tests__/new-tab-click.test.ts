import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Boss, TG 1802: "ha a kontrolt megnyomom a billentyuzeten, es ugy kattintok
// ra a gombra ... akkor egy uj bongeszofulon nyissa meg. Ugy, hogy ez a
// bongeszoful ugyanitt maradjon, ahol van."
// A new tab cannot see this tab's sessionStorage, so the target position rides
// in the URL (?view=<json>) and the #435 restore path takes it from there.

const WEB = join(__dirname, '..', '..', 'web')
const APP = readFileSync(join(WEB, 'app.js'), 'utf8')
const WBJS = readFileSync(join(WEB, 'workbench.js'), 'utf8')

function helperSource(): string {
  const start = APP.indexOf('// === F5 brings back the same view (#435) ===')
  const endMarker = 'window.openViewInNewTab = openViewInNewTab'
  const end = APP.indexOf(endMarker, start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return APP.slice(start, end + endMarker.length)
}

type Loaded = {
  viewStateTake: (p: string) => unknown
  isNewTabClick: (e: unknown) => boolean
  openViewInNewTab: (page: string | null, state: unknown, later?: boolean) => { go: (p: string, s: unknown) => void; cancel: () => void } | null
  opened: { url: string; target: string; features?: string }[]
  win: { location: { href: string }; closed: boolean; opener: unknown; close: () => void }
  loc: { hash: string; search: string; pathname: string; href: string }
  replaced: string[]
}

function load(hash: string, search = ''): Loaded {
  const loc = { hash, search, pathname: '/', href: 'http://localhost:3420/' + search + hash }
  const replaced: string[] = []
  const history = { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url) } }
  const store = new Map<string, string>()
  const sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  const opened: Loaded['opened'] = []
  const win = { location: { href: '' }, closed: false, opener: {} as unknown, close() { this.closed = true } }
  const window: Record<string, unknown> = {
    addEventListener: () => {},
    open: (url: string, target: string, features?: string) => { opened.push({ url, target, features }); return features === 'noopener' ? null : win },
  }
  const document = { visibilityState: 'visible', addEventListener: () => {} }
  const fn = new Function('location', 'sessionStorage', 'document', 'window', 'URLSearchParams', 'history', 'URL',
    helperSource() + '\nreturn { viewStateTake, isNewTabClick, openViewInNewTab }')
  const api = fn(loc, sessionStorage, document, window, URLSearchParams, history, URL)
  return { ...api, opened, win, loc, replaced }
}

describe('Ctrl+kattintas: uj bongeszoful, ez a ful marad (TG 1802)', () => {
  it('Ctrl, Cmd, Shift es a kozepso gomb az uj ful jele; a sima kattintas nem', () => {
    const l = load('#projects')
    expect(l.isNewTabClick({ ctrlKey: true, button: 0 })).toBe(true)
    expect(l.isNewTabClick({ metaKey: true, button: 0 })).toBe(true)
    expect(l.isNewTabClick({ shiftKey: true, button: 0 })).toBe(true)
    expect(l.isNewTabClick({ button: 1 })).toBe(true)
    expect(l.isNewTabClick({ button: 0 })).toBe(false)
    expect(l.isNewTabClick(null)).toBe(false)
  })

  it('az uj ful a celoldalt es a belso helyet a cimben kapja, _blank + noopener', () => {
    const l = load('#projects')
    l.openViewInNewTab('intezo', { path: 'Ügyfelek/Kovács' })
    expect(l.opened).toHaveLength(1)
    expect(l.opened[0].target).toBe('_blank')
    expect(l.opened[0].features).toBe('noopener')
    const u = new URL(l.opened[0].url, 'http://localhost:3420')
    expect(u.hash).toBe('#intezo')
    expect(JSON.parse(u.searchParams.get('view')!)).toEqual({ path: 'Ügyfelek/Kovács' })
    // Ez a ful nem mozdult.
    expect(l.loc.hash).toBe('#projects')
  })

  it('az uj ful a cimbol visszaveszi a helyet -- egyszer --, es a cimbol torli', () => {
    const view = encodeURIComponent(JSON.stringify({ current: 'p1', wb: { projectId: 'p1', item: 'w1' } }))
    const l = load('#projects', '?view=' + view)
    expect(l.replaced).toEqual(['/#projects'])
    expect(l.viewStateTake('projects')).toEqual({ current: 'p1', wb: { projectId: 'p1', item: 'w1' } })
    expect(l.viewStateTake('projects')).toBeNull()
  })

  it('egy masik oldalra szolo vagy hibas ?view nem nyit ki semmit', () => {
    const view = encodeURIComponent(JSON.stringify({ path: 'x' }))
    expect(load('#projects', '?view=' + view).viewStateTake('intezo')).toBeNull()
    const bad = load('#intezo', '?view=%7Bnem-json')
    expect(bad.viewStateTake('intezo')).toBeNull()
  })

  it('kesleltetett cel (szerverhivas utan): a ful a kattintasban nyilik, a cim utana jon', () => {
    const l = load('#projects')
    const tab = l.openViewInNewTab(null, null, true)!
    expect(l.opened[0].url).toBe('about:blank')
    expect(l.win.opener).toBeNull()
    tab.go('intezo', { path: 'P/Munka' })
    const u = new URL(l.win.location.href)
    expect(u.hash).toBe('#intezo')
    expect(JSON.parse(u.searchParams.get('view')!)).toEqual({ path: 'P/Munka' })
  })

  it('ha a szerverhivas elbukik, az ures ful bezarul', () => {
    const l = load('#projects')
    l.openViewInNewTab(null, null, true)!.cancel()
    expect(l.win.closed).toBe(true)
  })
})

describe('be van kotve a gombokra', () => {
  it('menu: valodi href, a modositott kattintast a bongeszore hagyja', () => {
    expect(APP).toContain("link.setAttribute('href', '#' + link.dataset.page)")
    expect(APP).toContain('if (link.dataset.page && isNewTabClick(e)) return')
  })

  it('Projektek oldal: a kattintaskezelo ELOSZOR az uj-ful agat nezi, kozepso gombra is', () => {
    expect(APP).toMatch(/document\.addEventListener\('click', \(e\) => \{\n {2}if \(_prjNewTabNav\(e\)\) \{ e\.preventDefault\(\); return \}/)
    expect(APP).toContain("if (e.button === 1 && _prjNewTabNav(e)) e.preventDefault()")
    for (const sel of ['[data-prj-open]', '[data-prj-return]', '[data-prj-reveal]', "a === 'open-intezo'"]) {
      expect(APP.slice(APP.indexOf('function _prjNewTabNav'), APP.indexOf('function _prjNewTabNav') + 2500)).toContain(sel)
    }
  })

  it('MEGA megnyitas: Ctrl+kattintasra uj ful', () => {
    expect(APP).toContain("if (isNewTabClick(e)) { openViewInNewTab('intezo', { path: b.getAttribute('data-megadepot-open') }); return }")
  })

  it('Munkapad: Munkapad-gomb, munkadarab es Megnyitas az Intezoben uj fulon', () => {
    const nav = WBJS.slice(WBJS.indexOf('function newTabNav'), WBJS.indexOf('function newTabNav') + 2000)
    expect(nav).toContain("closest('[data-wb-open]')")
    expect(nav).toContain("closest('[data-wb-item]')")
    expect(nav).toContain('[data-wb-act="folder-intezo"]')
    expect(WBJS).toContain('if (newTabNav(e)) { e.preventDefault(); return }')
    expect(WBJS).toContain('if (e.button === 1 && newTabNav(e)) e.preventDefault()')
    expect(WBJS).toContain("if (tab) { tab.go('intezo', { path: r.data.path }); return }")
  })
})
