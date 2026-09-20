// AI Munkapad (kanban #336, 1. fazis): a FELULET tenyleges viselkedese.
//
// jsdom nincs a projektben, de a Munkapad-kod szandekosan keveset var a DOM-tol
// (egy `#projectsRoot` innerHTML + delegalt kattintas-figyelo), ezert itt egy
// kis DOM-utanzattal TENYLEG lefuttatjuk a `web/workbench.js`-t. Igy nem csak
// a forras szovegét, hanem a valodi kimenetet merjuk:
//
//   1. ures allapot: barátságos mondat + "Uj munkadarab" gomb (nem hibauzenet);
//   2. az uj munkadarab vegigmegy A FELULETROL (urlap -> POST -> lista);
//   3. minden kepernyore kerulo szoveg a `t()`-n megy at (HU/EN), nincs
//      kezzel odairt magyar mondat.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')

type Handler = (e: unknown) => void

interface Harness {
  win: Record<string, any>
  rootEl: { innerHTML: string }
  click: (attrs: Record<string, string>) => void
  fetchCalls: { url: string; init?: RequestInit }[]
  toasts: string[]
  inputs: Record<string, { value: string; focus: () => void }>
  respond: (fn: (url: string, init?: RequestInit) => { status: number; body: unknown }) => void
}

/** Egy kattintas-esemeny: a `closest()` a megadott attributumokbol valaszol. */
function eventFor(attrs: Record<string, string>) {
  const target = {
    closest(sel: string) {
      const name = sel.slice(1, -1) // [data-wb-act] -> data-wb-act
      if (!(name in attrs)) return null
      return { getAttribute: (a: string) => (a in attrs ? attrs[a] : null) }
    },
  }
  return { target, preventDefault() {} }
}

function harness(): Harness {
  const clickHandlers: Handler[] = []
  const submitHandlers: Handler[] = []
  const rootEl = { innerHTML: '' }
  const inputs: Record<string, { value: string; focus: () => void }> = {}
  const toasts: string[] = []
  const fetchCalls: { url: string; init?: RequestInit }[] = []
  let responder: (url: string, init?: RequestInit) => { status: number; body: unknown } =
    () => ({ status: 200, body: {} })

  const doc = {
    addEventListener(type: string, fn: Handler) {
      if (type === 'click') clickHandlers.push(fn)
      if (type === 'submit') submitHandlers.push(fn)
    },
    getElementById(id: string) {
      if (id === 'projectsRoot') return rootEl
      return inputs[id] || null
    },
  }

  const win: Record<string, any> = {
    _lang: 'hu',
    // A valodi t() kulcs-visszaesését utanozzuk: ismeretlen kulcs = maga a
    // kulcs. Igy a teszt latja, ha egy szoveg nincs forditva.
    t: (key: string, params: Record<string, unknown> = {}) =>
      `⟦${key}${Object.keys(params).length ? ':' + JSON.stringify(params) : ''}⟧`,
    escapeHtml: (s: unknown) => String(s == null ? '' : s),
    escapeAttr: (s: unknown) => String(s == null ? '' : s),
    showToast: (m: string) => { toasts.push(m) },
  }

  const fakeFetch = (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init })
    const r = responder(url, init)
    return Promise.resolve({
      ok: r.status < 400,
      status: r.status,
      json: () => Promise.resolve(r.body),
    })
  }

  // A modul IIFE: `document`, `window` es `fetch` a hatokoreben.
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', 'fetch', SRC)(doc, win, fakeFetch)

  return {
    win,
    rootEl,
    inputs,
    toasts,
    fetchCalls,
    respond(fn) { responder = fn },
    click(attrs) { for (const h of clickHandlers) h(eventFor(attrs)) },
  }
}

const PROJECT = { id: 'p1', name: 'Kovács weboldal', archived: false }

function itemsBody(items: unknown[]) {
  return { project: PROJECT, items, types: ['document', 'image', 'graphic', 'video', 'note'], statuses: ['draft'] }
}

let h: Harness

beforeEach(() => {
  h = harness()
})

describe('belepesi pont', () => {
  it('a Munkapad a window-on erheto el, es indulaskor zarva van', () => {
    expect(typeof h.win.MarvinWorkbench.open).toBe('function')
    expect(h.win.MarvinWorkbench.isOpen()).toBe(false)
  })

  it('a projekt-oldali gomb (data-wb-open) nyitja meg', async () => {
    h.respond(() => ({ status: 200, body: itemsBody([]) }))
    h.click({ 'data-wb-open': 'p1', 'data-wb-open-name': 'Kovács weboldal' })
    expect(h.win.MarvinWorkbench.isOpen()).toBe(true)
    await vi.waitFor(() => expect(h.fetchCalls.length).toBeGreaterThan(0))
    expect(h.fetchCalls[0].url).toContain('/api/workbench/items?project=p1')
    // A nyelv minden hivason megy, hogy a szerver-oldali hiba is a jo nyelven jojjon.
    expect(h.fetchCalls[0].url).toContain('lang=hu')
  })
})

describe('harom paneles vaz', () => {
  beforeEach(async () => {
    h.respond(() => ({ status: 200, body: itemsBody([]) }))
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('wb-panel-context'))
  })

  it('mind a harom panel + a chat-sav helye kirajzolodik', () => {
    const html = h.rootEl.innerHTML
    expect(html).toContain('wb-panel-items')
    expect(html).toContain('wb-panel-editor')
    expect(html).toContain('wb-panel-context')
    expect(html).toContain('wb-chat')
  })

  it('a chat-sav LE VAN TILTVA es kiirja, hogy hamarosan jon', () => {
    const html = h.rootEl.innerHTML
    expect(html).toContain('workbench.chat.soon')
    // A bevitel es a gomb is tiltott -- ne lehessen bele irni es elkuldeni.
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('ures allapot: baratsagos mondat es "uj munkadarab" gomb, nem hiba', () => {
    const html = h.rootEl.innerHTML
    expect(html).toContain('workbench.empty.title')
    expect(html).toContain('workbench.empty.hint')
    expect(html).toContain('data-wb-act="new"')
    // Nem hibanak nez ki: nincs hiba-doboz.
    expect(html).not.toContain('depo-bad')
  })
})

describe('uj munkadarab -- vegig a feluletrol, terminal nelkul', () => {
  it('urlap -> POST -> ujratoltott lista', async () => {
    h.respond(() => ({ status: 200, body: itemsBody([]) }))
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-act="new"'))

    h.click({ 'data-wb-act': 'new' })
    expect(h.rootEl.innerHTML).toContain('wbNewForm')
    expect(h.rootEl.innerHTML).toContain('workbench.new.name_label')

    h.inputs.wbNewTitle = { value: '  Ajánlat  ', focus() {} }
    h.inputs.wbNewType = { value: 'document', focus() {} }

    const created = { id: 'w1', title: 'Ajánlat', type: 'document', status: 'draft', current_version_id: 'v1' }
    h.respond((url, init) => {
      if (init && init.method === 'POST') return { status: 201, body: { ok: true, item: created, versions: [{ id: 'v1', version_no: 1, created_at: 1 }] } }
      return { status: 200, body: itemsBody([created]) }
    })
    h.click({ 'data-wb-act': 'create' })

    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    const post = h.fetchCalls.find((c) => c.init && c.init.method === 'POST')
    expect(post, 'a letrehozas POST-tal megy').toBeTruthy()
    expect(JSON.parse(String(post!.init!.body))).toEqual({ project_id: 'p1', title: 'Ajánlat', type: 'document' })
    expect(h.toasts.join(' ')).toContain('workbench.new.created')
  })

  it('szerveroldali hiba eseten AZT a mondatot mutatja, amit a szerver kuldott', async () => {
    h.respond(() => ({ status: 200, body: itemsBody([]) }))
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-act="new"'))
    h.click({ 'data-wb-act': 'new' })
    h.inputs.wbNewTitle = { value: '', focus() {} }
    h.inputs.wbNewType = { value: 'note', focus() {} }
    h.respond(() => ({ status: 400, body: { error: 'title_required', message: 'Adj nevet a munkadarabnak.' } }))
    h.click({ 'data-wb-act': 'create' })
    await vi.waitFor(() => expect(h.toasts).toContain('Adj nevet a munkadarabnak.'))
    // Az urlap NYITVA marad, hogy javitani lehessen.
    expect(h.rootEl.innerHTML).toContain('wbNewForm')
  })
})

describe('archivalt projekt', () => {
  it('nem kinal uj munkadarabot, de a meglevoket mutatja', async () => {
    const item = { id: 'w1', title: 'Régi', type: 'note', status: 'draft' }
    h.respond(() => ({ status: 200, body: { ...itemsBody([item]), project: { ...PROJECT, archived: true } } }))
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    expect(h.rootEl.innerHTML).not.toContain('data-wb-act="new"')
    expect(h.rootEl.innerHTML).toContain('workbench.archived_hint')
    // A kattintas sem nyithatja meg az urlapot.
    h.click({ 'data-wb-act': 'new' })
    expect(h.rootEl.innerHTML).not.toContain('wbNewForm')
  })
})

describe('ketnyelvuseg', () => {
  it('minden kepernyore kerulo szoveg a t()-n megy at', async () => {
    h.respond(() => ({ status: 200, body: itemsBody([{ id: 'w1', title: 'Ajánlat', type: 'document', status: 'draft' }]) }))
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    // A t() jelolt kimenetet ad; ami marad, az csak jelolt szoveg, jelolo,
    // vagy a felhasznalo/szerver sajat adata (itt: a projekt es a munkadarab neve).
    const visible = h.rootEl.innerHTML
      .replace(/⟦[^⟧]*⟧/g, '')
      .replace(/<[^>]*>/g, ' ')
    const hungarian = visible.replace(/Kovács weboldal|Ajánlat/g, '')
    expect(hungarian).not.toMatch(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/)
  })

  it('a hasznalt forditas-kulcsok mindket nyelvben leteznek', async () => {
    const w = globalThis as unknown as { window?: Record<string, unknown> }
    w.window ||= {}
    await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
    await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
    const i18n = (w.window as { _i18n: Record<string, Record<string, string>> })._i18n
    // A statikus kulcsok + a ket ossze-fuzott csalad ('workbench.type.' + type,
    // 'workbench.status.' + status), amit a regex nem lat vegig.
    const used = [...SRC.matchAll(/\bt\('((?:workbench|common)\.[a-z_.]*[a-z_])'/g)].map((m) => m[1])
      .filter((k) => !k.endsWith('.'))
      .concat(['document', 'image', 'graphic', 'video', 'note'].map((ty) => 'workbench.type.' + ty))
      .concat(['draft', 'in_progress', 'review', 'done'].map((st) => 'workbench.status.' + st))
    expect(used.length).toBeGreaterThan(20)
    const missingHu = used.filter((k) => !(k in i18n.hu))
    const missingEn = used.filter((k) => !(k in i18n.en))
    expect(missingHu, 'hianyzo kulcsok a hu.js-bol').toEqual([])
    expect(missingEn, 'hianyzo kulcsok az en.js-bol').toEqual([])
  })
})

describe('mobil-paritas', () => {
  it('a harom panel kozott fulek valtanak (telefonon egyszerre egy latszik)', async () => {
    h.respond(() => ({ status: 200, body: itemsBody([]) }))
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('wb-panel-tabs'))
    expect(h.rootEl.innerHTML).toContain('data-wb-panel="items"')
    expect(h.rootEl.innerHTML).toContain('data-wb-panel="editor"')
    expect(h.rootEl.innerHTML).toContain('data-wb-panel="context"')
    h.click({ 'data-wb-panel': 'context' })
    expect(h.rootEl.innerHTML).toContain('wb-panel-context wb-panel-current')
  })

  it('a stiluslap mobil torespontnal egy panelre valt', () => {
    const css = readFileSync(join(ROOT, 'web', 'workbench.css'), 'utf8')
    const mobile = css.slice(css.indexOf('@media (max-width: 900px)'))
    expect(mobile).toContain('grid-template-columns: 1fr')
    expect(mobile).toContain('.wb-panel-tabs { display: flex')
    expect(mobile).toContain('.wb-panel-current { display: flex; }')
  })
})

describe('a Projektek oldalba illeszkedes', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')

  it('a projekt fejlecen ott a Munkapad-gomb, forditott szoveggel', () => {
    expect(app).toContain('data-wb-open="${escapeAttr(p.id)}"')
    expect(app).toContain("t('workbench.open')")
  })

  it('a kesve beerkezo projekt-betoltes nem rajzolja felul a Munkapadot', () => {
    expect(app).toContain('window.MarvinWorkbench && window.MarvinWorkbench.isOpen()')
  })

  it('a "vissza a projekthez" a meglevo projekt-nezetet nyitja ujra', () => {
    expect(SRC).toContain('window._prjOpenProject')
  })

  it('ha a Munkapad-fajl nem toltodott be, a gomb nem nema halott gomb', () => {
    expect(app).toContain("if (wbOpen && !window.MarvinWorkbench) { showToast(t('workbench.err.not_loaded')); return }")
  })
})
