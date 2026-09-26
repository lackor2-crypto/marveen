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
  /** Fajlvalaszto / legordulo: a VALODI `change`-figyelot szolaltatja meg.
   *  A `value` a legordulonel szamit (verzio-valaszto), a fajlvalasztonal ures. */
  change: (id: string, files: unknown[], value?: string) => void
  fetchCalls: { url: string; init?: RequestInit }[]
  toasts: string[]
  inputs: Record<string, { value: string; focus: () => void }>
  respond: (fn: (url: string, init?: RequestInit) => { status: number; body: unknown }) => void
  /** Huzas a vaszon egyik elemen: lenyomas -> mozgatas -> elengedes.
   *  A `grip` nelkul MOZGATAS, `grip`-pel (nw/ne/sw/se) ATMERETEZES.
   *  A visszaadott `box.style` az, amit a huzas KOZBEN latna a felhasznalo. */
  drag: (id: string, dx: number, dy: number, opts?: { grip?: string; cancel?: boolean; steps?: number }) => DragProbe
  /** Nyilbillentyu egy kijelolt vaszon-elemen. */
  arrow: (id: string, key: string, shift?: boolean) => void
  /** MINDEN kirajzolas, idorendben. Igy az is merheto, mit latott a
   *  felhasznalo KOZBEN -- nem csak a vegallapot. */
  renders: string[]
}

interface DragProbe {
  box: { style: Record<string, string>; className: string }
  stageWidth: number
  stageHeight: number
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

/** A vaszon kepernyon elfoglalt merete a probaban. A vaszon 1000x800
 *  egyseg, tehat 1 kepernyo-pixel = 2 vaszon-egyseg vizszintesen. */
const STAGE_W = 500
const STAGE_H = 400

/** Egy vaszon-elem doboza es a kepe, ugy ahogy a bongeszo adna: a `closest()`
 *  a dobozt, a szinpadot es (ha van) a megfogott sarkot adja vissza. */
function dragTargetFor(id: string, grip?: string) {
  const box = {
    style: {} as Record<string, string>,
    className: 'wb-can-box',
    getAttribute: (a: string) => (a === 'data-wb-box' ? id : null),
    setPointerCapture() {},
  }
  const stage = {
    getBoundingClientRect: () => ({ width: STAGE_W, height: STAGE_H, left: 0, top: 0 }),
    querySelectorAll: () => [box],
  }
  const gripEl = grip ? { getAttribute: () => grip } : null
  const target = {
    closest(sel: string) {
      if (sel === '[data-wb-box]') return box
      if (sel === '[data-wb-stage]') return stage
      if (sel === '[data-wb-grip]') return gripEl
      return null
    },
  }
  return {
    box,
    event(dx: number, dy: number) {
      return { target, clientX: 100 + dx, clientY: 100 + dy, preventDefault() {} }
    },
  }
}

function harness(): Harness {
  const clickHandlers: Handler[] = []
  const submitHandlers: Handler[] = []
  const changeHandlers: Handler[] = []
  const downHandlers: Handler[] = []
  const moveHandlers: Handler[] = []
  const upHandlers: Handler[] = []
  const cancelHandlers: Handler[] = []
  const keyHandlers: Handler[] = []
  const renders: string[] = []
  const rootEl = {
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v: string) { this._html = v; renders.push(v) },
  }
  const inputs: Record<string, { value: string; focus: () => void }> = {}
  const toasts: string[] = []
  const fetchCalls: { url: string; init?: RequestInit }[] = []
  let responder: (url: string, init?: RequestInit) => { status: number; body: unknown } =
    () => ({ status: 200, body: {} })

  const doc = {
    addEventListener(type: string, fn: Handler) {
      if (type === 'click') clickHandlers.push(fn)
      if (type === 'submit') submitHandlers.push(fn)
      if (type === 'change') changeHandlers.push(fn)
      if (type === 'pointerdown') downHandlers.push(fn)
      if (type === 'pointermove') moveHandlers.push(fn)
      if (type === 'pointerup') upHandlers.push(fn)
      if (type === 'pointercancel') cancelHandlers.push(fn)
      if (type === 'keydown') keyHandlers.push(fn)
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
    // Ha a valasz SZOVEG, akkor SSE-folyam (agent-chat): a `text()` adja vissza.
    const isText = typeof r.body === 'string'
    return Promise.resolve({
      ok: r.status < 400,
      status: r.status,
      json: () => (isText ? Promise.reject(new Error('not json')) : Promise.resolve(r.body)),
      text: () => Promise.resolve(isText ? (r.body as string) : JSON.stringify(r.body)),
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
    renders,
    respond(fn) { responder = fn },
    click(attrs) { for (const h of clickHandlers) h(eventFor(attrs)) },
    drag(id, dx, dy, opts = {}) {
      const probe = dragTargetFor(id, opts.grip)
      for (const fn of downHandlers) fn({ ...probe.event(0, 0), pointerId: 1 })
      const steps = opts.steps ?? 2
      for (let i = 1; i <= steps; i++) {
        const f = i / steps
        for (const fn of moveHandlers) fn(probe.event(dx * f, dy * f))
      }
      const enders = opts.cancel ? cancelHandlers : upHandlers
      for (const fn of enders) fn(probe.event(dx, dy))
      return { box: probe.box, stageWidth: STAGE_W, stageHeight: STAGE_H }
    },
    arrow(id, key, shift = false) {
      const probe = dragTargetFor(id)
      for (const fn of keyHandlers) fn({ ...probe.event(0, 0), key, shiftKey: shift })
    },
    change(id, files, value = '') {
      const e = { target: { id, files, value }, preventDefault() {} }
      for (const h of changeHandlers) h(e)
    },
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

  it('a chat SOHA nem szurke: munkadarab nelkul is lehet bele irni', () => {
    // Boss, 2026-09-21: "Agent-chat NE legyen szurke/letiltva, meg akkor sem, ha
    // nincs munkadarab kivalasztva." Ez a teszt pontosan ezt orzi.
    const html = h.rootEl.innerHTML
    expect(html).toContain('id="wbChatInput"')
    expect(html).toContain('data-wb-act="chat-send"')
    expect(html).not.toContain('aria-disabled="true"')
    expect(html).not.toContain('workbench.chat.soon')
    // A bevitel-mezo es a kuldes-gomb kozul EGYIK sem tiltott.
    const chat = html.slice(html.indexOf('id="wbChat"'))
    expect(chat).not.toMatch(/<textarea[^>]*disabled/)
    expect(chat).not.toMatch(/<button[^>]*data-wb-act="chat-send"[^>]*disabled/)
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
      // A csonkok ('workbench.status.', 'workbench.chat.tool_') nem kulcsok:
      // ezeket a lenti `concat`-ok soroljak fel teljesen.
      .filter((k) => !k.endsWith('.') && !k.endsWith('_'))
      .concat(['document', 'image', 'graphic', 'video', 'note'].map((ty) => 'workbench.type.' + ty))
      .concat(['draft', 'in_progress', 'review', 'done'].map((st) => 'workbench.status.' + st))
      // A tool-allapot kulcsai ossze vannak fuzve ('workbench.chat.tool_' + status).
      .concat(['running', 'ok', 'error', 'needs_approval', 'blocked'].map((st) => 'workbench.chat.tool_' + st))
    expect(used.length).toBeGreaterThan(20)
    const missingHu = used.filter((k) => !(k in i18n.hu))
    const missingEn = used.filter((k) => !(k in i18n.en))
    expect(missingHu, 'hianyzo kulcsok a hu.js-bol').toEqual([])
    expect(missingEn, 'hianyzo kulcsok az en.js-bol').toEqual([])
  })
})

describe('PDF-nezegeto -- sajat gepbol, nem CDN-rol (kartya f7d423e7)', () => {
  it('a konyvtar es minden futasideju adata a SAJAT kiszolgalonkrol jon', () => {
    // Friss, HALOZAT NELKULI telepitesen a CDN-es megoldas uresen hagyna az
    // elonezetet -- ezert egyetlen kulso gazdagepre mutato ut sem lehet benne.
    const pdfPart = SRC.slice(SRC.indexOf('PDFJS_LIB_URL'), SRC.indexOf('rajzvaszon (9. fazis, spec 9)'))
    expect(pdfPart).toContain("'/vendor/pdfjs/build/pdf.min.mjs'")
    expect(pdfPart).toContain("'/vendor/pdfjs/build/pdf.worker.min.mjs'")
    expect(pdfPart).not.toMatch(/https?:\/\//)
    expect(pdfPart).not.toMatch(/cdn|unpkg|jsdelivr|cloudflare/i)
    // A menet kozben toltodo adatok (karakterkeszlet-terkep, betutipus, wasm,
    // szinprofil) is a sajat vegpontrol -- ezek nelkul ures folt lenne a helyuk.
    for (const opt of ['cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl']) {
      expect(pdfPart).toContain(opt)
    }
  })

  it('a betoltes-hiba okat MEGKERDEZI a kiszolgalotol, nem talalja ki', () => {
    expect(SRC).toContain('pdfWhyLibFailed')
    // A 404 torzsebol olvassa ki az ember altal olvashato mondatot.
    expect(SRC).toMatch(/body && body\.message/)
    // Es ha a kiszolgalot sem eri el, AZT mondja ki, nem gyart okot.
    expect(SRC).toContain('workbench.pdf.failed_offline')
  })

  it('a konyvtar csak keresre toltodik be (amig nem nezel PDF-et, nulla bajt)', () => {
    // Nincs felso szintu import: a betoltes a pdfLoadLib()-ben, dinamikusan tortenik.
    expect(SRC).not.toMatch(/^\s*import\s/m)
    expect(SRC).toContain('import(PDFJS_LIB_URL)')
  })
})

describe('agent-chat (3. fazis)', () => {
  function sse(events: unknown[]): string {
    return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  }

  async function openChat(): Promise<void> {
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/status') >= 0) {
        return { status: 200, body: { provider: { id: 'anthropic', model: 'claude-sonnet-5', available: true }, usage: { usedPct: 12, measured: true }, allowed: true, maxMessageChars: 8000 } }
      }
      if (url.indexOf('/api/workbench/agent/session') >= 0) return { status: 200, body: { session: { id: 's1' }, messages: [], toolCalls: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('id="wbChatInput"'))
  }

  it('a projekt-szintu beszelgetest is VISSZAOLVASSA (nem csak a munkadarabet)', async () => {
    await openChat()
    // A NULLA ket dolgot jelenthet: ha nem kerdeznenk meg a szervert, egy mar
    // lefolytatott beszelgetes ugy latszana, mintha sosem lett volna.
    const urls = h.fetchCalls.map((c) => c.url)
    expect(urls.some((u) => u.indexOf('/api/workbench/agent/session?project=p1') >= 0)).toBe(true)
  })

  it('a mar meglevo uzenetek megjelennek a naploban', async () => {
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/session') >= 0) {
        return { status: 200, body: { session: { id: 's1' }, messages: [{ role: 'user', content: 'szia' }, { role: 'assistant', content: 'szia, itt vagyok' }], toolCalls: [] } }
      }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: false, message: 'Nincs beállítva AI-szolgáltató.' }, usage: { usedPct: null, measured: false, message: 'nem mérhető' }, allowed: true } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('szia, itt vagyok'))
  })

  it('#402: visszatolteskor is latszik, melyik fiokkal es modellel ment a valasz', async () => {
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/session') >= 0) {
        return { status: 200, body: { session: { id: 's1' }, messages: [
          { role: 'user', content: 'szia' },
          { role: 'assistant', content: 'elso valasz', model: 'modell-a', via_kind: 'account', via_account: 'fiok-agens' },
          { role: 'assistant', content: 'masodik valasz', model: 'modell-b', via_kind: 'api_key', via_account: null },
          { role: 'assistant', content: 'regi valasz' },
        ], toolCalls: [] } }
      }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 1, measured: true }, allowed: true } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('regi valasz'))
    const html = h.rootEl.innerHTML
    expect(html).toContain('⟦workbench.chat.via_account:{"account":"fiok-agens","model":"modell-a"}⟧')
    expect(html).toContain('⟦workbench.chat.via_api_key:{"model":"modell-b"}⟧')
    // A regi, meta nelkuli sornal nem talalunk ki semmit.
    expect((html.match(/wb-turn-via/g) || []).length).toBe(2)
  })

  it('a MERETLEN keret nem nulla szazalek, es a hianyzo szolgaltato kiirodik', async () => {
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/status') >= 0) {
        return { status: 200, body: { provider: { available: false, message: 'Nincs beállítva AI-szolgáltató.' }, usage: { usedPct: null, measured: false, message: 'A keret állapotát most nem tudom megmérni.' }, allowed: true } }
      }
      if (url.indexOf('/api/workbench/agent/session') >= 0) return { status: 200, body: { session: { id: 's1' }, messages: [], toolCalls: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('Nincs beállítva AI-szolgáltató.'))
    const html = h.rootEl.innerHTML
    expect(html).toContain('A keret állapotát most nem tudom megmérni.')
    expect(html).not.toContain('0%')
    // ...es a beallitas UGYANINNEN elerheto, terminal nelkul.
    expect(html).toContain('data-wb-act="chat-setup"')
  })

  it('kuldes: POST a /agent/message-re, munkadarab nelkul is (work_item_id: null)', async () => {
    await openChat()
    h.inputs.wbChatInput = { value: 'csinálj egy posztot', focus() {} }
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/message') >= 0) {
        return { status: 200, body: sse([{ type: 'session', sessionId: 's1' }, { type: 'text', text: 'Rendben, ' }, { type: 'text', text: 'megcsinálom.' }, { type: 'done', model: 'claude-sonnet-5', via: { kind: 'account', account: 'fo-agens' } }]) }
      }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 1, measured: true }, allowed: true } }
      if (url.indexOf('/api/workbench/agent/session') >= 0) return { status: 200, body: { session: { id: 's1' }, messages: [], toolCalls: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.click({ 'data-wb-act': 'chat-send' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('megcsinálom.'))
    const call = h.fetchCalls.find((c) => c.url.indexOf('/api/workbench/agent/message') >= 0)
    expect(call).toBeTruthy()
    const body = JSON.parse(String(call?.init?.body))
    expect(body.project_id).toBe('p1')
    expect(body.work_item_id).toBe(null)
    expect(body.message).toBe('csinálj egy posztot')
    // A sajat uzenet is ott marad a naploban.
    expect(h.rootEl.innerHTML).toContain('csinálj egy posztot')
    // #402: a streamelt valasz alatt is ott a fiok + modell.
    expect(h.rootEl.innerHTML).toContain('⟦workbench.chat.via_account:{"account":"fo-agens","model":"claude-sonnet-5"}⟧')
  })

  it('a jovahagyasra varo tool-hivas LATSZIK, a jegy azonositojaval', async () => {
    await openChat()
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/message') >= 0) {
        return { status: 200, body: sse([
          { type: 'tool', name: 'workItem.create', status: 'running' },
          { type: 'tool', name: 'workItem.create', status: 'needs_approval', detail: 'jóváhagyás kell', approvalId: 'ap-7' },
          { type: 'done', model: 'm' },
        ]) }
      }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 1, measured: true }, allowed: true } }
      if (url.indexOf('/api/workbench/agent/session') >= 0) return { status: 200, body: { session: { id: 's1' }, messages: [], toolCalls: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.inputs.wbChatInput = { value: 'hozz létre egy munkadarabot', focus() {} }
    h.click({ 'data-wb-act': 'chat-send' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('workItem.create'))
    const html = h.rootEl.innerHTML
    expect(html).toContain('workbench.chat.tool_needs_approval')
    expect(html).toContain('ap-7')
    // Egy tool-hivas EGY sor: a "fut..." nem marad ott a vegleges allapot mellett.
    expect(html).not.toContain('workbench.chat.tool_running')
  })

  // #406 0. pont: folyamatjelzo. Boss: latszodjon, mit csinal MOST az agens,
  // es a nyers {"tool":...} JSON soha ne keruljon a kepernyore.
  it('folyamatjelzo: tetlen -> kesz, az eszkoz EMBERI nevevel', async () => {
    await openChat()
    expect(h.rootEl.innerHTML).toContain('id="wbChatActivity"')
    expect(h.rootEl.innerHTML).toContain('workbench.chat.act_idle')
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/message') >= 0) {
        return { status: 200, body: sse([
          { type: 'tool', name: 'file.read', status: 'running' },
          { type: 'tool', name: 'file.read', status: 'ok' },
          { type: 'text', text: 'Megvan.' },
          { type: 'done', model: 'm' },
        ]) }
      }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 1, measured: true }, allowed: true } }
      if (url.indexOf('/api/workbench/agent/session') >= 0) return { status: 200, body: { session: { id: 's1' }, messages: [], toolCalls: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.inputs.wbChatInput = { value: 'olvasd el', focus() {} }
    h.click({ 'data-wb-act': 'chat-send' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('workbench.chat.act_done'))
    // Kozben a "Gondolkodik" allapot latszott (nem csak a vegeredmeny).
    expect(h.renders.some((r) => r.indexOf('workbench.chat.act_thinking') >= 0)).toBe(true)
    expect(h.rootEl.innerHTML).toContain('workbench.tool.file.read')
  })

  it('folyamatjelzo: eredmeny nelkuli valasznal "Nem jott valasz", nem orok "Gondolkodik"', async () => {
    await openChat()
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/message') >= 0) return { status: 200, body: sse([{ type: 'done', model: 'm' }]) }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 1, measured: true }, allowed: true } }
      if (url.indexOf('/api/workbench/agent/session') >= 0) return { status: 200, body: { session: { id: 's1' }, messages: [], toolCalls: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.inputs.wbChatInput = { value: 'hahó', focus() {} }
    h.click({ 'data-wb-act': 'chat-send' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('workbench.chat.act_no_answer'))
    expect(h.rootEl.innerHTML).toContain('workbench.chat.no_answer')
  })

  it('a regi, csak-eszkozhivas elozmeny-sor nem nyers JSON-kent jelenik meg', async () => {
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/session') >= 0) {
        return { status: 200, body: { session: { id: 's1' }, messages: [
          { role: 'user', content: 'nézd meg' },
          { role: 'assistant', content: '{"tool":"project.getContext","args":{}}' },
        ], toolCalls: [] } }
      }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 1, measured: true }, allowed: true } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('workbench.tool.project.getContext'))
    expect(h.rootEl.innerHTML).not.toContain('{&quot;tool&quot;')
    expect(h.rootEl.innerHTML).not.toContain('{"tool"')
    expect(h.rootEl.innerHTML).toContain('workbench.chat.tool_history')
  })

  it('minden szerveroldali eszkoznek van emberi neve mindket nyelven', async () => {
    const { TOOLS } = await import('../workbench-agent/tools.js')
    const w = globalThis as unknown as { window?: Record<string, unknown> }
    w.window ||= {}
    await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
    await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
    const i18n = (w.window as { _i18n: Record<string, Record<string, string>> })._i18n
    const keys = TOOLS.map((tool) => 'workbench.tool.' + tool.name)
    expect(keys.filter((k) => !(k in i18n.hu))).toEqual([])
    expect(keys.filter((k) => !(k in i18n.en))).toEqual([])
  })

  it('ha az agens munkadarabot hozott letre, a LISTA is frissul', async () => {
    await openChat()
    var listazas = 0
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/message') >= 0) {
        return { status: 200, body: sse([
          { type: 'tool', name: 'workItem.create', status: 'running' },
          { type: 'tool', name: 'workItem.create', status: 'ok' },
          { type: 'text', text: 'Elkészült.' },
          { type: 'done', model: 'm' },
        ]) }
      }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 1, measured: true }, allowed: true } }
      if (url.indexOf('/api/workbench/agent/session') >= 0) return { status: 200, body: { session: { id: 's1' }, messages: [], toolCalls: [] } }
      listazas++
      return { status: 200, body: itemsBody([{ id: 'w9', title: 'Facebook-poszt', type: 'document', status: 'draft' }]) }
    })
    h.inputs.wbChatInput = { value: 'csinálj egy Facebook-posztot', focus() {} }
    h.click({ 'data-wb-act': 'chat-send' })
    // A lista a szervertol jon ujra -- nem a chat talalgatja ki, mi keletkezett.
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('Facebook-poszt'))
    expect(listazas).toBeGreaterThan(0)
  })

  it('szerver-hiba eseten AZT a mondatot mutatja, amit a szerver kuldott', async () => {
    await openChat()
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/message') >= 0) return { status: 429, body: { error: 'quota', message: 'Most nincs szabad keret.' } }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 99, measured: true }, allowed: true } }
      if (url.indexOf('/api/workbench/agent/session') >= 0) return { status: 200, body: { session: { id: 's1' }, messages: [], toolCalls: [] } }
      return { status: 200, body: itemsBody([]) }
    })
    h.inputs.wbChatInput = { value: 'szia', focus() {} }
    h.click({ 'data-wb-act': 'chat-send' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('Most nincs szabad keret.'))
  })

  it('a beallito urlap csak a modellt kinalja es menti -- kulcs-mezo nincs (#404)', async () => {
    await openChat()
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/config') >= 0) return { status: 200, body: { WORKBENCH_MODEL: '' } }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: false, message: 'Nincs beállítva AI-szolgáltató.' }, usage: { usedPct: null, measured: false }, allowed: true } }
      return { status: 200, body: itemsBody([]) }
    })
    h.click({ 'data-wb-act': 'chat-setup' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('id="wbChatSetup"'))
    expect(h.rootEl.innerHTML).not.toContain('wbChatKey')
    expect(h.rootEl.innerHTML).not.toContain('console.anthropic.com')
    expect(h.rootEl.innerHTML).toContain('workbench.chat.setup_intro')

    h.inputs.wbChatModel = { value: 'claude-sonnet-5', focus() {} }
    h.click({ 'data-wb-act': 'chat-setup-save' })
    await vi.waitFor(() => {
      const post = h.fetchCalls.find((c) => c.url.indexOf('/api/workbench/agent/config') >= 0 && c.init && c.init.method === 'POST')
      expect(post).toBeTruthy()
      expect(JSON.parse(String(post?.init?.body))).toEqual({ WORKBENCH_MODEL: 'claude-sonnet-5' })
    })
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

  // A rajzolas-gat (isOpen -> korai visszateres) csak akkor helyes, ha a
  // "nyitva" jelzo NEM eli tul az oldalvaltast: kulonben a projekt-oldal
  // nemán megall, es a felhasznalo ures dobozban ragad.
  it('a Projektek oldal betoltese alaphelyzetbe teszi a Munkapadot', () => {
    expect(app).toContain('window.MarvinWorkbench?.reset?.()')
  })

  it('a reset nem rajzol es nem visz vissza a projekt-oldalra', () => {
    h.respond(() => ({ status: 200, body: itemsBody([]) }))
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    expect(h.win.MarvinWorkbench.isOpen()).toBe(true)
    h.rootEl.innerHTML = 'MAS RAJZOLTA'
    h.win.MarvinWorkbench.reset()
    expect(h.win.MarvinWorkbench.isOpen()).toBe(false)
    expect(h.rootEl.innerHTML).toBe('MAS RAJZOLTA')
  })

  // Boss 2026-09-21: ures projektben eltunt mind a harom ful, tehat a
  // feluletrol nem lehetett letrehozni az ELSO otletet/vitat/hatteranyagot.
  it('az Otletlada / Vitaztatas / Kutatas ful darabszam nelkul is megjelenik', () => {
    const fn = app.slice(app.indexOf('function _prjTypeTabHtml'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).not.toContain("return ''")
    expect(body).toContain('data-prj-tab="${type}"')
  })
})

// --- 3. fazis: VEGYES munkadarab (kep ES szoveg EGY munkadarabban) ----------

const MIXED = { id: 'w1', title: 'Poszt', type: 'composite', status: 'draft' }

function detailBody(parts: unknown[]) {
  return {
    item: MIXED,
    versions: [],
    parts,
    part_kinds: ['text', 'image'],
    project: PROJECT,
  }
}

const TEXT_PART = { id: 'pt1', kind: 'text', position: 1, text: 'A poszt szövege' }
const IMAGE_PART = { id: 'pi1', kind: 'image', position: 2, asset_path: 'Projektek/teszt/foto.jpg', caption: 'A fotó' }

async function openMixed(parts: unknown[]) {
  h.respond((url) => {
    if (url.indexOf('/api/workbench/items/') === 0) return { status: 200, body: detailBody(parts) }
    return { status: 200, body: itemsBody([MIXED]) }
  })
  h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('workbench.parts.title'))
}

describe('vegyes munkadarab -- kep ES szoveg EGY munkadarabban', () => {
  it('a szoveg es a kep EGYUTT jelenik meg, a kep a projektmappabol', async () => {
    await openMixed([TEXT_PART, IMAGE_PART])
    const html = h.rootEl.innerHTML
    expect(html).toContain('A poszt szövege')
    expect(html).toContain('<img class="wb-part-image"')
    // A parameter neve `rel` -- a `/api/life/file` EZT olvassa (`path`-szal 404).
    expect(html).toContain('/api/life/file?rel=' + encodeURIComponent('Projektek/teszt/foto.jpg'))
    expect(html).toContain('A fotó')
    // Mindketto UGYANABBAN a munkadarabban van: egy reszlista, ket sor.
    expect((html.match(/data-wb-part-row=/g) || []).length).toBe(2)
  })

  it('ures reszlista: baratsagos mondat, nem hibauzenet (a NULLA nem hiba)', async () => {
    await openMixed([])
    const html = h.rootEl.innerHTML
    expect(html).toContain('workbench.parts.empty')
    expect(html).not.toContain('depo-bad')
    // A felvetel utja OTT van a feluleten: terminal nem kell hozza.
    expect(html).toContain('data-wb-act="part-new-text"')
    expect(html).toContain('id="wbPartImage"')
  })

  it('szoveg-resz felvetele vegigmegy A FELULETROL', async () => {
    await openMixed([])
    h.click({ 'data-wb-act': 'part-new-text' })
    expect(h.rootEl.innerHTML).toContain('wbPartNewForm')

    h.inputs.wbPartNewText = { value: 'Új bekezdés', focus() {} }
    h.respond(() => ({ status: 200, body: { ok: true, parts: [{ id: 'pt9', kind: 'text', position: 1, text: 'Új bekezdés' }] } }))
    h.click({ 'data-wb-act': 'part-add-text' })

    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('Új bekezdés'))
    const post = h.fetchCalls.filter((c) => c.init && c.init.method === 'POST').pop()
    expect(post!.url).toContain('/api/workbench/items/w1/parts')
    expect(JSON.parse(String(post!.init!.body))).toEqual({ kind: 'text', text: 'Új bekezdés' })
    expect(h.toasts.join(' ')).toContain('workbench.parts.added')
  })

  it('kep feltoltese a mappat NEM a felhasznalora bizza: nyers bajtok POST-tal', async () => {
    await openMixed([])
    h.respond(() => ({ status: 200, body: { ok: true, parts: [IMAGE_PART] } }))
    h.change('wbPartImage', [{ name: 'foto.jpg', type: 'image/jpeg', size: 1024 }])
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('wb-part-image'))
    const post = h.fetchCalls.filter((c) => c.init && c.init.method === 'POST').pop()
    expect(post!.url).toContain('/api/workbench/items/w1/parts/image')
    expect(post!.url).toContain('name=foto.jpg')
    expect(post!.url).toContain('lang=hu')
  })

  it('a kep-feltoltes szerver-hibajanal AZ A mondat megy ki, amit a szerver kuldott', async () => {
    await openMixed([])
    h.respond(() => ({ status: 400, body: { error: 'no_folder', message: 'Ehhez a projekthez még nincs mappa kiválasztva.' } }))
    h.change('wbPartImage', [{ name: 'foto.jpg', type: 'image/jpeg', size: 1024 }])
    await vi.waitFor(() => expect(h.toasts).toContain('Ehhez a projekthez még nincs mappa kiválasztva.'))
  })

  it('torlesnel megkerdezi, es kimondja, hogy a KEPFAJL a helyen marad', async () => {
    await openMixed([TEXT_PART, IMAGE_PART])
    const asked: string[] = []
    h.win.confirm = (m: string) => { asked.push(m); return true }
    h.respond(() => ({ status: 200, body: { ok: true, parts: [TEXT_PART] } }))
    h.click({ 'data-wb-act': 'part-remove', 'data-wb-part': 'pi1' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.parts.removed'))
    expect(asked).toContain('⟦workbench.parts.remove_confirm⟧')
    const del = h.fetchCalls.filter((c) => c.init && c.init.method === 'DELETE').pop()
    expect(del!.url).toContain('/api/workbench/items/w1/parts/pi1')
  })

  it('a NEM-re nem torol semmit', async () => {
    await openMixed([TEXT_PART, IMAGE_PART])
    h.win.confirm = () => false
    const before = h.fetchCalls.length
    h.click({ 'data-wb-act': 'part-remove', 'data-wb-part': 'pi1' })
    expect(h.fetchCalls.length).toBe(before)
  })

  it('a sorrend a szerverrol jon vissza, nem a felulet talalja ki', async () => {
    await openMixed([TEXT_PART, IMAGE_PART])
    h.respond(() => ({ status: 200, body: { ok: true, parts: [IMAGE_PART, TEXT_PART] } }))
    h.click({ 'data-wb-act': 'part-up', 'data-wb-part': 'pi1' })
    await vi.waitFor(() => {
      const html = h.rootEl.innerHTML
      expect(html.indexOf('data-wb-part-row="pi1"')).toBeLessThan(html.indexOf('data-wb-part-row="pt1"'))
    })
    const post = h.fetchCalls.filter((c) => c.init && c.init.method === 'POST').pop()
    expect(post!.url).toContain('/parts/pi1/move')
    expect(JSON.parse(String(post!.init!.body))).toEqual({ dir: 'up' })
  })

  it('archivalt projektben nincs se felvetel, se torles-gomb', async () => {
    h.respond((url) => {
      if (url.indexOf('/api/workbench/items/') === 0) {
        return { status: 200, body: { ...detailBody([TEXT_PART]), project: { ...PROJECT, archived: true } } }
      }
      return { status: 200, body: { ...itemsBody([MIXED]), project: { ...PROJECT, archived: true } } }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('workbench.parts.title'))
    const html = h.rootEl.innerHTML
    expect(html).not.toContain('data-wb-act="part-new-text"')
    expect(html).not.toContain('data-wb-act="part-remove"')
    // A meglevo tartalmat viszont tovabbra is latja.
    expect(html).toContain('A poszt szövege')
  })
})

// --- 4. fazis: ELONEZET (a kozepso panel) ----------------------------------
//
// A kerdes, amit ez a blokk orzi: "mit LAT a felhasznalo, es ha nem lat
// semmit, megmondjuk-e, MIERT?" A NULLA ket dolgot jelenthet -- a "meg nincs
// semmi" baratsagos, a "nem latok oda" HANGOS, es a ketto nem nezhet ki
// ugyanugy.

const PREV_ITEM = { id: 'w1', title: 'Ajánlat', type: 'document', status: 'draft' }

function previewDetail(versions: unknown[] = []) {
  return { item: PREV_ITEM, versions, parts: [], part_kinds: ['text', 'image'], project: PROJECT }
}

/** Megnyit egy munkadarabot, es a /preview vegpont EZT a valaszt adja. */
async function openPreview(preview: Record<string, unknown>, versions: unknown[] = []) {
  h.respond((url) => {
    if (url.indexOf('/preview') > 0) return { status: 200, body: preview }
    if (url.indexOf('/api/workbench/items/') === 0) return { status: 200, body: previewDetail(versions) }
    return { status: 200, body: itemsBody([PREV_ITEM]) }
  })
  h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('wb-preview'))
}

describe('elonezet -- a kozepso panel (4. fazis)', () => {
  it('PDF: a SAJAT nezegetonk helye all ott (nem a bongesze), es van "uj lapon" ut is', async () => {
    await openPreview({
      available: true, kind: 'pdf', mime: 'application/pdf', name: 'ajanlat.pdf',
      rel: 'Projektek/teszt/ajanlat.pdf', reason: null, message: null,
      url: '/api/life/file?rel=Projektek%2Fteszt%2Fajanlat.pdf&lang=hu',
    })
    const html = h.rootEl.innerHTML
    // A nezegeto HELYE kerul a HTML-be; a lapokat a render() utan futo
    // pdfMount() teszi bele, mert a kirajzolt lapoknak TUL kell elniuk az
    // ujrarajzolast. Iframe (a bongeszo sajat nezegetoje) tobbe nincs: az
    // bongeszonkent maskepp nezett ki (kartya f7d423e7).
    expect(html).toContain('class="wb-pdf-slot"')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('data-wb-pdf="/api/life/file?rel=')
    // A bajtokat a MEGLEVO fajl-kiszolgalo adja: nincs masodik fajl-ut.
    expect(html).toContain('/api/life/file?rel=')
    expect(html).toContain('workbench.preview.open_new_tab')
    // A letoltes-ut megmarad: ha a nezegeto barmiert nem indul, a fajlhoz
    // a felhasznalo akkor is hozzafer.
    expect(html).toContain('workbench.preview.download')
    expect(html).toContain('ajanlat.pdf')
  })

  it('kep: kepkent latszik, nem letoltendo fajlkent', async () => {
    await openPreview({
      available: true, kind: 'image', mime: 'image/jpeg', name: 'foto.jpg',
      rel: 'Projektek/teszt/foto.jpg', reason: null, message: null,
      url: '/api/life/file?rel=Projektek%2Fteszt%2Ffoto.jpg&lang=hu',
    })
    expect(h.rootEl.innerHTML).toContain('<img class="wb-preview-image"')
  })

  it('szoveg: a tartalom latszik, es a levagast KIMONDJA', async () => {
    await openPreview({
      available: true, kind: 'text', mime: 'text/plain', name: 'jegyzet.txt',
      rel: 'Projektek/teszt/jegyzet.txt', reason: null, message: null,
      text: 'Az első bekezdés', truncated: true, url: null,
    })
    const html = h.rootEl.innerHTML
    expect(html).toContain('Az első bekezdés')
    expect(html).toContain('workbench.preview.truncated')
  })

  it('amit a bongeszo nem tud (docx): A SZERVER mondata + letoltes, NEM vesz-szinu', async () => {
    await openPreview({
      available: false, kind: null, reason: 'unsupported', name: 'szerzodes.docx',
      rel: 'Projektek/teszt/szerzodes.docx', url: null,
      message: 'Ezt a fájltípust a böngésző nem tudja megmutatni.',
    })
    const html = h.rootEl.innerHTML
    // A gepi kod HELYETT emberi mondat -- pontosan az, amit a szerver kuldott.
    expect(html).toContain('Ezt a fájltípust a böngésző nem tudja megmutatni.')
    expect(html).not.toContain('unsupported<')
    expect(html).toContain('workbench.preview.download')
    // Ez nem hiba: nincs veszjelzes.
    expect(html).not.toContain('wb-preview-bad')
  })

  it('a NULLA ket dolgot jelent: az "ures" halk, a "nem latok oda" HANGOS', async () => {
    await openPreview({
      available: false, kind: null, reason: 'no_source', name: null, rel: null, url: null,
      message: 'Ehhez a munkadarabhoz még nincs megjeleníthető tartalom.',
    })
    const quiet = h.rootEl.innerHTML
    expect(quiet).toContain('Ehhez a munkadarabhoz még nincs megjeleníthető tartalom.')
    expect(quiet).not.toContain('wb-preview-bad')

    h = harness()
    await openPreview({
      available: false, kind: null, reason: 'no_depot', name: 'ajanlat.pdf',
      rel: 'ajanlat.pdf', url: null,
      message: 'Nincs beállítva Raktár, ezért a fájlhoz nem látok oda.',
    })
    const loud = h.rootEl.innerHTML
    expect(loud).toContain('wb-preview-bad')
    expect(loud).toContain('Raktár')
  })

  it('egy verzional nincs valaszto; tobbnel van, es valtasra UJ kerest indit', async () => {
    const one = [{ id: 'v1', version_no: 1, created_at: 1 }]
    await openPreview({ available: false, reason: 'no_source', kind: null, rel: null, url: null, message: 'x', versions: one }, one)
    expect(h.rootEl.innerHTML).not.toContain('id="wbPreviewVersion"')

    h = harness()
    const two = [{ id: 'v2', version_no: 2, created_at: 2 }, { id: 'v1', version_no: 1, created_at: 1 }]
    await openPreview({ available: false, reason: 'no_source', kind: null, rel: null, url: null, message: 'x', version_id: 'v2', versions: two }, two)
    expect(h.rootEl.innerHTML).toContain('id="wbPreviewVersion"')

  })

  it('verzio-valtas: a kert verzio azonositoja MEGY A KERESBEN', async () => {
    const two = [{ id: 'v2', version_no: 2, created_at: 2 }, { id: 'v1', version_no: 1, created_at: 1 }]
    await openPreview({ available: false, reason: 'no_source', kind: null, rel: null, url: null, message: 'x', version_id: 'v2', versions: two }, two)
    h.change('wbPreviewVersion', [], 'v1')
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.indexOf('version=v1') > 0)).toBe(true))
    const asked = h.fetchCalls.filter((c) => c.url.indexOf('/preview') > 0).pop()
    expect(asked!.url).toContain('version=v1')
    expect(asked!.url).toContain('lang=hu')
  })
})

// --- 5. fazis: VERZIOZAS a feluleten ---------------------------------------
//
// Spec 12: "az eredeti automatikusan nem irhato felul", a visszaallitas UJ
// verziot csinal, a kesobbiek megmaradnak. A felulet ezt MONDJA IS KI, mielott
// a felhasznalo rakattint.

const V2 = { id: 'v2', version_no: 2, created_at: 2, restored_from_no: null }
const V1 = { id: 'v1', version_no: 1, created_at: 1, restored_from_no: null }

async function openVersions(versions: unknown[], item = { ...PREV_ITEM, current_version_id: 'v2' }) {
  h.respond((url) => {
    if (url.indexOf('/preview') > 0) return { status: 200, body: { available: false, reason: 'no_source', kind: null, rel: null, url: null, message: 'x', versions } }
    if (url.indexOf('/api/workbench/items/') === 0) return { status: 200, body: { item, versions, parts: [], part_kinds: ['text', 'image'], project: PROJECT } }
    return { status: 200, body: itemsBody([item]) }
  })
  h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('workbench.context.versions'))
}

describe('verziozas -- a feluletrol, terminal nelkul (5. fazis)', () => {
  it('a JELENLEGI verziohoz nincs visszaallitas, a regihez van', async () => {
    await openVersions([V2, V1])
    const html = h.rootEl.innerHTML
    expect(html).toContain('data-wb-act="version-restore"')
    expect(html).toContain('data-wb-version="v1"')
    // A mostanit nincs mire visszaallitani.
    expect(html).not.toContain('data-wb-version="v2"')
    // A mentes utja is ott van, es a szabaly ki van irva.
    expect(html).toContain('data-wb-act="version-new"')
    expect(html).toContain('workbench.versions.hint')
  })

  it('visszaallitas elott MEGKERDEZI, es kimondja, hogy semmi nem vesz el', async () => {
    await openVersions([V2, V1])
    const asked: string[] = []
    h.win.confirm = (m: string) => { asked.push(m); return true }
    h.respond(() => ({
      status: 201,
      body: { ok: true, item: { ...PREV_ITEM, current_version_id: 'v3' }, version: { id: 'v3', version_no: 3 }, versions: [{ id: 'v3', version_no: 3, created_at: 3, restored_from_no: 1 }, V2, V1], parts: [] },
    }))
    h.click({ 'data-wb-act': 'version-restore', 'data-wb-version': 'v1' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.versions.restored'))
    expect(asked).toContain('⟦workbench.versions.restore_confirm⟧')
    const post = h.fetchCalls.filter((c) => c.init && c.init.method === 'POST').pop()
    expect(post!.url).toContain('/api/workbench/items/w1/versions/v1/restore')
    // A visszaallitas utan a lista a frisset mutatja, es KIIRJA, mibol allt vissza.
    expect(h.rootEl.innerHTML).toContain('workbench.versions.restored_from')
  })

  it('a "nem" valasz tenyleg nem csinal semmit', async () => {
    await openVersions([V2, V1])
    h.win.confirm = () => false
    const before = h.fetchCalls.length
    h.click({ 'data-wb-act': 'version-restore', 'data-wb-version': 'v1' })
    expect(h.fetchCalls.length).toBe(before)
  })

  it('mentes uj verziokent: POST a /versions-re, es szol rola', async () => {
    await openVersions([V2, V1])
    h.respond(() => ({
      status: 201,
      body: { ok: true, item: { ...PREV_ITEM, current_version_id: 'v3' }, version: { id: 'v3', version_no: 3 }, versions: [{ id: 'v3', version_no: 3, created_at: 3 }, V2, V1] },
    }))
    h.click({ 'data-wb-act': 'version-new' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.versions.saved'))
    const post = h.fetchCalls.filter((c) => c.init && c.init.method === 'POST').pop()
    expect(post!.url).toContain('/api/workbench/items/w1/versions')
    expect(post!.url).not.toContain('/restore')
  })

  it('a szerver hibajanal AZ A mondat megy ki, amit a szerver kuldott', async () => {
    await openVersions([V2, V1])
    h.win.confirm = () => true
    h.respond(() => ({ status: 409, body: { error: 'project_archived', message: 'Ez a projekt archivált, ezért csak olvasható.' } }))
    h.click({ 'data-wb-act': 'version-restore', 'data-wb-version': 'v1' })
    await vi.waitFor(() => expect(h.toasts).toContain('Ez a projekt archivált, ezért csak olvasható.'))
  })

  it('archivalt projektben nincs se visszaallitas, se uj verzio gomb', async () => {
    const item = { ...PREV_ITEM, current_version_id: 'v2' }
    const versions = [V2, V1]
    h.respond((url) => {
      if (url.indexOf('/preview') > 0) return { status: 200, body: { available: false, reason: 'no_source', kind: null, rel: null, url: null, message: 'x', versions } }
      if (url.indexOf('/api/workbench/items/') === 0) {
        return { status: 200, body: { item, versions, parts: [], part_kinds: ['text', 'image'], project: { ...PROJECT, archived: true } } }
      }
      return { status: 200, body: { ...itemsBody([item]), project: { ...PROJECT, archived: true } } }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('workbench.context.versions'))
    const html = h.rootEl.innerHTML
    expect(html).not.toContain('data-wb-act="version-restore"')
    expect(html).not.toContain('data-wb-act="version-new"')
  })
})

// ---------------------------------------------------------------------------
// IRODAI DOKUMENTUM -> PDF, es a KOR BEZARASA (7. fazis, spec 8 + 24)
//
// Amit ez oriz: a ".docx-et nem tudom megmutatni" NEM zsakutca. Van gomb ra, a
// hiba EMBERI mondat + a VALODI reszlet (nem gepi kod), az "ujra" pedig UJRA
// MEGMERI a gepet -- telepites utan azonnal jo valaszt ad, nem a regibol
// beszel. A fajlhoz kozben soha nem nyulunk hozza: letoltheto vegig.

describe('irodai dokumentum: atalakitas es visszatoltes (7. fazis)', () => {
  const OFFICE_NEEDS = {
    available: false, kind: 'office', reason: 'needs_conversion', name: 'szerzodes.docx',
    rel: 'Projektek/teszt/szerzodes.docx', url: null,
    office: { ext: 'docx', ready: false },
    message: 'Ezt a dokumentumot PDF-fé alakítva tudom megmutatni.',
  }

  it('kesz PDF: a sajat nezegetonk + KIMONDJUK, hogy ez a belole keszult PDF, es mindketto letoltheto', async () => {
    await openPreview({
      available: true, kind: 'office', mime: 'application/pdf', name: 'szerzodes.docx',
      rel: 'Projektek/teszt/szerzodes.docx', reason: null, message: null,
      office: { ext: 'docx', ready: true },
      url: '/api/workbench/items/w1/converted?lang=hu',
    })
    const html = h.rootEl.innerHTML
    expect(html).toContain('class="wb-pdf-slot"')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('/api/workbench/items/w1/converted?lang=hu')
    // Nem hallgatjuk el, hogy ez mar az atalakitott valtozat.
    expect(html).toContain('workbench.preview.office_from_pdf')
    expect(html).toContain('workbench.preview.office_download_pdf')
    // Az EREDETI fajl ugyanugy elerheto marad.
    expect(html).toContain('workbench.preview.office_download_source')
    expect(html).toContain('/api/life/file?rel=')
  })

  it('meg nincs atalakitva: TEENDO-gomb + a szerver mondata, nem veszjelzes', async () => {
    await openPreview(OFFICE_NEEDS)
    const html = h.rootEl.innerHTML
    expect(html).toContain('Ezt a dokumentumot PDF-fé alakítva tudom megmutatni.')
    expect(html).toContain('data-wb-act="preview-convert"')
    expect(html).toContain('workbench.preview.convert')
    // A sajat fajljahoz atalakitas nelkul is hozzafer.
    expect(html).toContain('workbench.preview.download')
    // Ez nem hiba: nincs vesz-szinu doboz, es nincs gepi kod a kepernyon.
    expect(html).not.toContain('wb-preview-bad')
    expect(html).not.toContain('needs_conversion<')
  })

  it('a gombra kattintva ATALAKIT, es utana ujratolti az elonezetet', async () => {
    await openPreview(OFFICE_NEEDS)
    let converted = false
    h.respond((url, init) => {
      if (url.indexOf('/convert') > 0 && init && init.method === 'POST') {
        converted = true
        return { status: 200, body: { ok: true, ready: true, cached: false, ext: 'docx', url: '/api/workbench/items/w1/converted?lang=hu' } }
      }
      if (url.indexOf('/preview') > 0) {
        return {
          status: 200,
          body: converted
            ? { available: true, kind: 'office', mime: 'application/pdf', name: 'szerzodes.docx', rel: OFFICE_NEEDS.rel, reason: null, message: null, office: { ext: 'docx', ready: true }, url: '/api/workbench/items/w1/converted?lang=hu' }
            : OFFICE_NEEDS,
        }
      }
      return { status: 200, body: previewDetail([]) }
    })
    h.click({ 'data-wb-act': 'preview-convert' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('class="wb-pdf-slot"'))
    expect(h.toasts.join(' ')).toContain('workbench.preview.converted')
    expect(h.fetchCalls.some((c) => c.url.indexOf('/convert') > 0)).toBe(true)
  })

  it('ha nincs LibreOffice: a SZERVER mondata + a VALODI reszlet latszik, nem gepi kod', async () => {
    await openPreview(OFFICE_NEEDS)
    h.respond((url, init) => {
      if (url.indexOf('/convert') > 0 && init && init.method === 'POST') {
        return {
          status: 501,
          body: {
            error: 'convert_not_installed',
            message: 'Ehhez a LibreOffice kellene a gépre. Linuxon: sudo apt install libreoffice.',
            detail: 'spawn soffice ENOENT',
          },
        }
      }
      if (url.indexOf('/preview') > 0) return { status: 200, body: OFFICE_NEEDS }
      return { status: 200, body: previewDetail([]) }
    })
    h.click({ 'data-wb-act': 'preview-convert' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('apt install libreoffice'))
    const html = h.rootEl.innerHTML
    // A valodi hibauzenet is ott van -- nem talalgatunk helyette okot.
    expect(html).toContain('spawn soffice ENOENT')
    expect(html).not.toContain('convert_not_installed')
    // Van tovabblepes: ujraprobalas, es a fajl letoltese.
    expect(html).toContain('data-wb-act="preview-convert-retry"')
    expect(html).toContain('workbench.preview.download')
  })

  it('az "ujra" ELOSZOR UJRA MEGMERI a gepet (force), nem a regi meresbol valaszol', async () => {
    await openPreview(OFFICE_NEEDS)
    h.respond((url, init) => {
      if (url.indexOf('/capabilities') > 0) return { status: 200, body: { capabilities: [{ key: 'office_to_pdf', available: true, state: 'ok' }] } }
      if (url.indexOf('/convert') > 0 && init && init.method === 'POST') {
        return { status: 200, body: { ok: true, ready: true, cached: false, ext: 'docx', url: '/api/workbench/items/w1/converted?lang=hu' } }
      }
      if (url.indexOf('/preview') > 0) return { status: 200, body: OFFICE_NEEDS }
      return { status: 200, body: previewDetail([]) }
    })
    h.click({ 'data-wb-act': 'preview-convert-retry' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.indexOf('/convert') > 0)).toBe(true))
    const cap = h.fetchCalls.find((c) => c.url.indexOf('/capabilities') > 0)
    expect(cap).toBeTruthy()
    expect(String(cap!.url)).toContain('force=1')
    // A sorrend szamit: eloszor meres, aztan atalakitas.
    const capAt = h.fetchCalls.findIndex((c) => c.url.indexOf('/capabilities') > 0)
    const convAt = h.fetchCalls.findIndex((c) => c.url.indexOf('/convert') > 0)
    expect(capAt).toBeLessThan(convAt)
  })

  it('visszatoltott dokumentum UJ VERZIO lesz -- a feluletrol, terminal nelkul', async () => {
    await openPreview(OFFICE_NEEDS)
    expect(h.rootEl.innerHTML).toContain('id="wbDocUpload"')
    expect(h.rootEl.innerHTML).toContain('workbench.versions.upload_document')

    h.respond((url, init) => {
      if (url.indexOf('/document') > 0 && init && init.method === 'POST') {
        return {
          status: 201,
          body: {
            ok: true, renamed: false, name: 'szerzodes.docx',
            item: { ...PREV_ITEM, current_version_id: 'v2' },
            version: { id: 'v2', version_no: 2, created_at: 2 },
            versions: [{ id: 'v1', version_no: 1, created_at: 1 }, { id: 'v2', version_no: 2, created_at: 2 }],
            file: { name: 'szerzodes.docx', rel: 'Projektek/teszt/szerzodes.docx' },
          },
        }
      }
      if (url.indexOf('/preview') > 0) return { status: 200, body: OFFICE_NEEDS }
      return { status: 200, body: previewDetail([]) }
    })
    h.change('wbDocUpload', [{ name: 'szerzodes.docx' }])
    await vi.waitFor(() => expect(h.toasts.length).toBeGreaterThan(0))
    const sent = h.fetchCalls.find((c) => c.url.indexOf('/document') > 0)
    expect(sent).toBeTruthy()
    expect(String(sent!.url)).toContain('name=szerzodes.docx')
    expect(h.toasts.join(' ')).toContain('workbench.versions.uploaded')
  })

  it('ha a nev foglalt volt, a felulet KIMONDJA az uj nevet -- nem csendben mas neven all', async () => {
    await openPreview(OFFICE_NEEDS)
    h.respond((url, init) => {
      if (url.indexOf('/document') > 0 && init && init.method === 'POST') {
        return {
          status: 201,
          body: {
            ok: true, renamed: true, name: 'szerzodes (2).docx',
            item: { ...PREV_ITEM, current_version_id: 'v2' },
            version: { id: 'v2', version_no: 2, created_at: 2 },
            versions: [],
            file: { name: 'szerzodes (2).docx', rel: 'Projektek/teszt/szerzodes (2).docx' },
          },
        }
      }
      if (url.indexOf('/preview') > 0) return { status: 200, body: OFFICE_NEEDS }
      return { status: 200, body: previewDetail([]) }
    })
    h.change('wbDocUpload', [{ name: 'szerzodes.docx' }])
    await vi.waitFor(() => expect(h.toasts.length).toBeGreaterThan(0))
    expect(h.toasts.join(' ')).toContain('workbench.versions.uploaded_renamed')
    expect(h.toasts.join(' ')).toContain('szerzodes (2).docx')
  })

  it('feltoltesi hibanal a SZERVER mondata jon, nem allapotkod', async () => {
    await openPreview(OFFICE_NEEDS)
    h.respond((url, init) => {
      if (url.indexOf('/document') > 0 && init && init.method === 'POST') {
        return { status: 413, body: { error: 'document_too_large', message: 'Ez a fájl nagyobb, mint amit fel lehet tölteni.' } }
      }
      if (url.indexOf('/preview') > 0) return { status: 200, body: OFFICE_NEEDS }
      return { status: 200, body: previewDetail([]) }
    })
    h.change('wbDocUpload', [{ name: 'nagy.docx' }])
    await vi.waitFor(() => expect(h.toasts.length).toBeGreaterThan(0))
    expect(h.toasts.join(' ')).toContain('Ez a fájl nagyobb')
    expect(h.toasts.join(' ')).not.toContain('document_too_large')
  })
})

// ---------------------------------------------------------------------------
// 8. FAZIS -- "Mi mukodik ezen a gepen?" panel. A felhasznalo nem programozo:
// allapot-cimke + emberi mondat + SZAMOZOTT lepesek + LINK + beiro mezo, es
// egy gomb, amivel azonnal ujra meri. Terminal nelkul, friss telepitesen is.
// ---------------------------------------------------------------------------
describe('kepesseg-panel (8. fazis)', () => {
  const CAPS = [
    {
      key: 'office_to_pdf', tier: 'recommended', title: 'Irodai dokumentum előnézete',
      what_for: 'A böngésző nem mutatja a Word-fájlt.', affects: 'Enélkül is minden működik.',
      how_to: ['Linux: sudo apt install libreoffice', 'Írd be alább a teljes útvonalat.'],
      obtain_url: 'https://www.libreoffice.org/download/download-libreoffice/',
      optional: true, available: false, state: 'check_failed',
      message: 'Nem sikerült megállapítani, hogy elérhető-e -- ez NEM azt jelenti, hogy hiányzik.',
      detail: 'MARVEEN_SOFFICE=/rossz/ut: spawn EACCES', version: null, path: null,
      checked_at: 1758600000000, testable: true,
      setting: { key: 'WORKBENCH_LIBREOFFICE_PATH', value: '', secret: false, configured: false, label: 'A LibreOffice teljes útvonala', placeholder: '/usr/bin/soffice' },
    },
    {
      key: 'video_render', tier: 'extra', title: 'Videóműveletek (FFmpeg)',
      what_for: 'Videó vágása, átalakítása.', affects: 'A Munkapad többi része enélkül is működik.',
      how_to: ['Linux: sudo apt install ffmpeg'], obtain_url: 'https://ffmpeg.org/download.html',
      optional: true, available: false, state: 'not_installed',
      message: 'Nincs telepítve ezen a gépen.', detail: null, version: null, path: null,
      checked_at: 1758600000000, testable: true,
      setting: { key: 'WORKBENCH_FFMPEG_PATH', value: '', secret: false, configured: false, label: 'Az FFmpeg teljes útvonala', placeholder: '/usr/bin/ffmpeg' },
    },
    {
      key: 'ai_agent', tier: 'core', title: 'Munkapad-ügynök',
      what_for: 'Ő írja a munkadarabot.', affects: 'Enélkül kézi szerkesztőként működik.',
      how_to: ['Alapesetben nincs teendőd.'], obtain_url: null,
      optional: false, available: true, state: 'ok', message: 'Elérhető (claude-opus-5).',
      detail: null, version: 'claude-opus-5', path: 'anthropic', checked_at: 1758600000000, testable: true,
      // #404: a Munkapad-ugynoknek nincs beallitasa (egyetlen ut az elofizetes).
      setting: null,
    },
    {
      key: 'tts', tier: 'extra', title: 'Felolvasás (ElevenLabs)',
      what_for: 'Szöveg felolvasása.', affects: 'A Munkapad többi része működik.',
      how_to: ['Ebben a verzióban még nincs bekötve.'], obtain_url: null,
      optional: true, available: false, state: 'not_implemented', message: 'Ebben a verzióban még nincs bekötve.',
      detail: null, version: null, path: null, checked_at: 1758600000000, testable: false, setting: null,
    },
  ]

  async function openPanel(caps: unknown = CAPS) {
    h.respond((url) => {
      if (url.indexOf('/api/workbench/capabilities') >= 0) return { status: 200, body: { capabilities: caps } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('wb-panel-context'))
    h.click({ 'data-wb-act': 'caps-open' })
    // A panel elobb "meres folyamatban" allapotban jelenik meg -- a sorokra
    // varunk, kulonben a toltes-allapotot merne a teszt.
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('<ul class="wb-caps">'))
  }

  it('a gomb megnyitja, es a lista a szerver EMBERI mondatait mutatja', async () => {
    await openPanel()
    const html = h.rootEl.innerHTML
    expect(html).toContain('Irodai dokumentum előnézete')
    expect(html).toContain('Nincs telepítve ezen a gépen.')
    // Szamozott lepesek ES kattinthato link -- nem "lasd a leirast".
    expect(html).toContain('sudo apt install libreoffice')
    expect(html).toContain('https://www.libreoffice.org/download/download-libreoffice/')
  })

  it('a "nem tudtam megkerdezni" a VALODI hibauzenetet is kiirja', async () => {
    await openPanel()
    expect(h.rootEl.innerHTML).toContain('MARVEEN_SOFFICE=/rossz/ut: spawn EACCES')
    expect(h.rootEl.innerHTML).toContain('workbench.caps.state.check_failed')
  })

  it('EXTRA hianya SOHA nem veszjelzes: nem kap piros jelolest', async () => {
    await openPanel()
    const html = h.rootEl.innerHTML
    const ffmpegRow = html.slice(html.indexOf('Videóműveletek'))
    expect(html.indexOf('wb-cap wb-cap-neutral')).toBeGreaterThan(-1)
    // A hozza tartozo sor a semleges osztalyt kapja, nem a figyelmeztetot.
    const rowStart = html.lastIndexOf('<li class="wb-cap', html.indexOf('Videóműveletek'))
    expect(html.slice(rowStart, rowStart + 60)).toContain('wb-cap-neutral')
    expect(ffmpegRow.slice(0, 200)).not.toContain('wb-cap-warn')
  })

  it('amihez nincs megvalositas: nincs beallito mezo es nincs ellenorzes-gomb', async () => {
    await openPanel()
    const html = h.rootEl.innerHTML
    const row = html.slice(html.indexOf('Felolvasás (ElevenLabs)'))
    expect(row).not.toContain('data-wb-act="cap-test" data-wb-cap="tts"')
    expect(row).not.toContain('wbCapSet-')
  })

  it('TITOKNAL jelszo-mezo all, ures ertekkel -- a kulcs sosem kerul a kepernyore', async () => {
    // A felulet altalanos titok-kezeleset merjuk egy kitalalt titkos sorral:
    // a Munkapadnak jelenleg nincs titkos beallitasa (#404).
    const caps = CAPS.map((c) => (c.key === 'video_render'
      ? { ...c, setting: { key: 'WORKBENCH_TEST_SECRET', value: null, secret: true, configured: false, label: 'Titok', placeholder: '' } }
      : c))
    await openPanel(caps)
    const html = h.rootEl.innerHTML
    expect(html).toContain('id="wbCapSet-WORKBENCH_TEST_SECRET" type="password"')
    expect(html).toContain('workbench.caps.secret_empty')
  })

  it('#404: a Munkapad-ugynok soraban nincs beallito mezo (sajat API-kulcs nincs)', async () => {
    await openPanel()
    expect(h.rootEl.innerHTML).not.toContain('wbCapSet-WORKBENCH_ANTHROPIC_API_KEY')
  })

  it('"Ellenorzes most" ujramer, es a sor AZONNAL az uj allapotot mutatja', async () => {
    await openPanel()
    h.respond((url) => {
      if (url.indexOf('/capabilities/video_render/test') >= 0) {
        return { status: 200, body: { capability: { ...CAPS[1], state: 'ok', available: true, message: 'Elérhető (ffmpeg version 7.1).', version: 'ffmpeg version 7.1' } } }
      }
      return { status: 200, body: { capabilities: CAPS } }
    })
    h.click({ 'data-wb-act': 'cap-test', 'data-wb-cap': 'video_render' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('Elérhető (ffmpeg version 7.1).'))
    expect(h.fetchCalls.some((c) => c.url.indexOf('/capabilities/video_render/test') >= 0)).toBe(true)
  })

  it('az utat be lehet irni a FELULETROL, es a valasz az uj meres + visszajelzes', async () => {
    await openPanel()
    h.inputs['wbCapSet-WORKBENCH_FFMPEG_PATH'] = { value: '/opt/ffmpeg/bin/ffmpeg', focus() {} }
    h.respond((url) => {
      if (url.indexOf('/capabilities/video_render/setting') >= 0) {
        return { status: 200, body: { saved: true, message: 'Elmentve, és azonnal újra megmértem.', capability: { ...CAPS[1], state: 'ok', available: true, message: 'Elérhető (ffmpeg version 6.0).', path: '/opt/ffmpeg/bin/ffmpeg' } } }
      }
      return { status: 200, body: { capabilities: CAPS } }
    })
    h.click({ 'data-wb-act': 'cap-save', 'data-wb-cap': 'video_render' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('Elérhető (ffmpeg version 6.0).'))
    const call = h.fetchCalls.find((c) => c.url.indexOf('/capabilities/video_render/setting') >= 0)!
    expect(JSON.parse(String(call.init!.body))).toEqual({ value: '/opt/ffmpeg/bin/ffmpeg' })
    expect(h.toasts.join(' ')).toContain('Elmentve')
  })

  it('ha a lekerdezes elbukik: "nem lattam oda" -- SOHA nem "nincs egy kepesseg sem"', async () => {
    h.respond((url) => {
      if (url.indexOf('/api/workbench/capabilities') >= 0) return { status: 500, body: { error: 'boom', message: 'A mérés most nem sikerült.' } }
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('wb-panel-context'))
    h.click({ 'data-wb-act': 'caps-open' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('A mérés most nem sikerült.'))
    // Nem allitjuk, hogy ures a lista.
    expect(h.rootEl.innerHTML).not.toContain('<ul class="wb-caps"></ul>')
  })

  it('a "Mindet ujramerem" gomb FORCE-szal kerdez -- nem a regi meresbol valaszol', async () => {
    await openPanel()
    h.fetchCalls.length = 0
    h.click({ 'data-wb-act': 'caps-refresh' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.indexOf('force=1') >= 0)).toBe(true))
  })

  it('minden kepernyore kerulo sajat szoveg a t()-n megy at (HU/EN)', async () => {
    await openPanel()
    const html = h.rootEl.innerHTML
    for (const key of ['workbench.caps.title', 'workbench.caps.intro', 'workbench.caps.howto', 'workbench.caps.test', 'workbench.caps.save']) {
      expect(html).toContain(key)
    }
  })
})

// ============================================================================
// 9. FAZIS -- RAJZVASZON A FELULETEN
//
// A felhasznalo NEM programozo: nem JSON-t szerkeszt, hanem gombokat nyom
// ("Kozepre", "Nagyobb"). Amit itt merunk: a KEPET latja (nem nyers adatot),
// a "meg nincs rajz" barátságos kezdoallapot (nem hibauzenet), a "nem latok
// oda" HANGOS, es minden kepernyore kerulo szoveg a t()-n megy at.
// ============================================================================
describe('rajzvaszon a feluletrol (9. fazis)', () => {
  const GRAPHIC = { id: 'w1', title: 'Nyári plakát', type: 'graphic', status: 'draft' }
  const DOC = {
    version: 1, width: 1000, height: 800, background: '#ffffff',
    objects: [
      { id: 'headline', type: 'text', x: 0, y: 0, width: 800, height: 120, fontSize: 72, text: 'Ride for less', color: '#111111', align: 'left', font: 'sans', weight: 'bold' },
      { id: 'keret', type: 'rect', x: 10, y: 10, width: 200, height: 100, fill: '#eeeeee', stroke: 'none', radius: 0 },
    ],
  }
  const CANVAS_OK = {
    canvas: DOC, exists: true, rel: 'Projektek/teszt/nyari-plakat.canvas.json',
    name: 'nyari-plakat.canvas.json', version_id: 'v2', version_no: 2,
    limits: { max_objects: 200, text_max: 2000 }, summary: '2 elem',
  }
  const CANVAS_EMPTY = {
    canvas: { version: 1, width: 1080, height: 1080, background: '#ffffff', objects: [] },
    exists: false, rel: null, name: null, version_id: 'v1', version_no: 1,
    limits: { max_objects: 200, text_max: 2000 }, summary: '',
  }

  /** Megnyit egy GRAFIKA munkadarabot, a /canvas vegpont EZT adja vissza.
   *  Az `until` a BETOLTOTT allapot jelolője: a vaszon-doboz eloszor "toltes"
   *  allapotban jelenik meg, es enelkul a teszt AZT merne. */
  async function openCanvas(canvas: unknown = CANVAS_OK, status = 200, until = 'wb-can-objs') {
    h.respond((url) => {
      if (url.indexOf('/canvas') > 0) return { status, body: canvas }
      if (url.indexOf('/preview') > 0) {
        return { status: 200, body: { available: true, kind: 'canvas', mime: 'image/svg+xml', name: 'nyari-plakat.canvas.json', rel: 'Projektek/teszt/nyari-plakat.canvas.json', reason: null, message: null, url: null } }
      }
      if (url.indexOf('/api/workbench/items/') === 0) {
        return { status: 200, body: { item: GRAPHIC, versions: [], parts: [], part_kinds: ['text', 'image'], project: PROJECT } }
      }
      return { status: 200, body: itemsBody([GRAPHIC]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain(until))
  }

  it('meg nincs rajz: BARATSAGOS kezdoallapot + "Kezdjunk egy vasznat" gomb, nem hibauzenet', async () => {
    await openCanvas(CANVAS_EMPTY, 200, 'data-wb-act="canvas-start"')
    const html = h.rootEl.innerHTML
    expect(html).toContain('workbench.canvas.none_title')
    expect(html).toContain('data-wb-act="canvas-start"')
    // Ez NEM hiba: nincs vesz-szinu doboz es nincs gepi kod a kepernyon.
    expect(html).not.toContain('wb-preview-bad')
    expect(html).not.toContain('canvas_missing')
  })

  it('"nem latok oda": HANGOS doboz, a szerver mondataval ES a VALODI reszlettel', async () => {
    await openCanvas({ error: 'canvas_no_depot', message: 'A rajz fájljához nem látok oda: nincs beállítva a Raktár ezen a gépen.', detail: 'Projektek/teszt/nyari-plakat.canvas.json' }, 409, 'data-wb-act="canvas-refresh"')
    const html = h.rootEl.innerHTML
    expect(html).toContain('wb-preview-bad')
    expect(html).toContain('A rajz fájljához nem látok oda')
    expect(html).toContain('Projektek/teszt/nyari-plakat.canvas.json')
    // A "nem latok oda" SOHA nem lesz "meg nincs rajz".
    expect(html).not.toContain('data-wb-act="canvas-start"')
  })

  it('a KEPET mutatja (SVG), nem a nyers adatot, es le is lehet tolteni', async () => {
    await openCanvas()
    const html = h.rootEl.innerHTML
    expect(html).toContain('/api/workbench/items/w1/canvas.svg')
    expect(html).toContain('download=1')
    expect(html).toContain('workbench.canvas.download')
    // A felhasznalo SOSE lat JSON-t.
    expect(html).not.toContain('"objects"')
  })

  it('a kep URL-je a mentes utan VALTOZIK (nem a gyorsitotarbol jon a regi kep)', async () => {
    await openCanvas()
    const first = /canvas\.svg[^"]*v=([\d-]+)/.exec(h.rootEl.innerHTML)
    expect(first).not.toBeNull()
    h.respond((url) => {
      if (url.indexOf('/canvas/ops') > 0) {
        return { status: 201, body: { ok: true, canvas: DOC, item: GRAPHIC, applied: [{ op: 'center', id: 'headline' }], versions: [], message: 'Mentve' } }
      }
      if (url.indexOf('/canvas') > 0) return { status: 200, body: CANVAS_OK }
      return { status: 200, body: { item: GRAPHIC, versions: [], parts: [], part_kinds: [], project: PROJECT } }
    })
    h.click({ 'data-wb-act': 'canvas-op', 'data-wb-op': 'center', 'data-wb-obj': 'headline' })
    await vi.waitFor(() => {
      const now = /canvas\.svg[^"]*v=([\d-]+)/.exec(h.rootEl.innerHTML)
      expect(now && now[1]).not.toBe(first && first[1])
    })
  })

  it('minden elem SAJAT nevvel (azonositoval) all a listan -- errol tud beszelni az agent is', async () => {
    await openCanvas()
    const html = h.rootEl.innerHTML
    expect(html).toContain('headline')
    expect(html).toContain('keret')
    expect(html).toContain('data-wb-act="canvas-edit"')
  })

  it('"Kozepre" gomb: STRUKTURALT muveletet kuld, nem koordinatat irat be a userrel', async () => {
    await openCanvas()
    h.fetchCalls.length = 0
    h.respond((url) => {
      if (url.indexOf('/canvas/ops') > 0) return { status: 201, body: { ok: true, canvas: DOC, item: GRAPHIC, applied: [], versions: [], message: 'Mentve' } }
      return { status: 200, body: CANVAS_OK }
    })
    h.click({ 'data-wb-act': 'canvas-op', 'data-wb-op': 'center', 'data-wb-obj': 'headline' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.indexOf('/canvas/ops') > 0)).toBe(true))
    const call = h.fetchCalls.filter((c) => c.url.indexOf('/canvas/ops') > 0)[0]
    const sent = JSON.parse(String(call.init && call.init.body))
    expect(sent.ops[0].op).toBe('center')
    expect(sent.ops[0].id).toBe('headline')
  })

  it('"Nagyobb": 1.3-as szorzo megy ki -- a user nem szamol betumeretet', async () => {
    await openCanvas()
    h.fetchCalls.length = 0
    h.respond(() => ({ status: 201, body: { ok: true, canvas: DOC, item: GRAPHIC, applied: [], versions: [], message: 'Mentve' } }))
    h.click({ 'data-wb-act': 'canvas-op', 'data-wb-op': 'bigger', 'data-wb-obj': 'headline' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.indexOf('/canvas/ops') > 0)).toBe(true))
    const sent = JSON.parse(String(h.fetchCalls.filter((c) => c.url.indexOf('/canvas/ops') > 0)[0].init!.body))
    expect(sent.ops[0].op).toBe('scale')
    expect(sent.ops[0].factor).toBeGreaterThan(1)
  })

  it('a szerkesztes UGYANAZON az uton megy, mint az agent (egy `update` muvelet)', async () => {
    await openCanvas()
    h.click({ 'data-wb-act': 'canvas-edit', 'data-wb-obj': 'headline' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-act="canvas-save"'))
    h.inputs['wbCanText'] = { value: 'Új cím', focus() {} }
    h.fetchCalls.length = 0
    h.respond(() => ({ status: 201, body: { ok: true, canvas: DOC, item: GRAPHIC, applied: [], versions: [], message: 'Mentve' } }))
    h.click({ 'data-wb-act': 'canvas-save', 'data-wb-obj': 'headline' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.indexOf('/canvas/ops') > 0)).toBe(true))
    const sent = JSON.parse(String(h.fetchCalls.filter((c) => c.url.indexOf('/canvas/ops') > 0)[0].init!.body))
    expect(sent.ops[0].op).toBe('update')
    expect(sent.ops[0].id).toBe('headline')
  })

  it('torles elott MEGKERDEZI (visszafordithatatlan lepes), es a "nem" tenyleg nem csinal semmit', async () => {
    await openCanvas()
    h.win.confirm = () => false
    h.fetchCalls.length = 0
    h.click({ 'data-wb-act': 'canvas-remove', 'data-wb-obj': 'keret' })
    expect(h.fetchCalls.filter((c) => c.url.indexOf('/canvas/ops') > 0)).toHaveLength(0)
  })

  it('a szerver hibajanal AZ A mondat megy ki, amit a szerver kuldott (nem talalgatas)', async () => {
    await openCanvas()
    h.respond((url) => {
      if (url.indexOf('/canvas/ops') > 0) {
        return { status: 400, body: { error: 'canvas_object_not_found', message: 'Nincs ilyen elem a vásznon.', detail: 'no object "cim". Objects: headline, keret' } }
      }
      return { status: 200, body: CANVAS_OK }
    })
    h.click({ 'data-wb-act': 'canvas-op', 'data-wb-op': 'center', 'data-wb-obj': 'headline' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('Nincs ilyen elem a vásznon.'))
    // A MERT is latszik, nem csak az emberi mondat.
    expect(h.rootEl.innerHTML).toContain('no object "cim"')
  })

  it('ARCHIVALT projektben a rajz latszik, de nincs szerkeszto gomb', async () => {
    h.respond((url) => {
      if (url.indexOf('/canvas') > 0) return { status: 200, body: CANVAS_OK }
      if (url.indexOf('/preview') > 0) return { status: 200, body: { available: true, kind: 'canvas', name: 'x.canvas.json', rel: 'Projektek/teszt/x.canvas.json', reason: null, message: null, url: null } }
      if (url.indexOf('/api/workbench/items/') === 0) {
        return { status: 200, body: { item: GRAPHIC, versions: [], parts: [], part_kinds: [], project: { ...PROJECT, archived: 1 } } }
      }
      return { status: 200, body: { project: { ...PROJECT, archived: 1 }, items: [GRAPHIC], types: ['graphic'], statuses: ['draft'] } }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('wb-can-objs'))
    const html = h.rootEl.innerHTML
    expect(html).toContain('/api/workbench/items/w1/canvas.svg')
    expect(html).not.toContain('data-wb-act="canvas-add-text"')
  })

  it('minden kepernyore kerulo sajat szoveg a t()-n megy at (HU/EN)', async () => {
    await openCanvas()
    const html = h.rootEl.innerHTML
    for (const key of ['workbench.canvas.title', 'workbench.canvas.intro', 'workbench.canvas.download', 'workbench.canvas.add_text', 'workbench.canvas.center']) {
      expect(html).toContain(key)
    }
  })
})

// ============================================================================
// HUZOGATOS SZERKESZTES A VASZNON (kartya d4b05d82)
//
// A tulajdonos szava: "kell a huzogatos!". Amit itt merunk: a kep FOLOTT all
// egy doboz-reteg (a kepet tovabbra is a SZERVER rajzolja, tehat a letoltott
// kep = a latott kep), a huzas KOZBEN nincs halozati keres, az elengedeskor
// PONTOSAN EGY `update` muvelet megy, es ha a reteg NEM jelenik meg, azt
// kimondjuk -- a nema hianyzas a legrosszabb valasz.
// ============================================================================
describe('huzogatos szerkesztes a vasznon (kartya d4b05d82)', () => {
  const GRAPHIC = { id: 'w1', title: 'Nyári plakát', type: 'graphic', status: 'draft' }
  const DOC = {
    version: 1, width: 1000, height: 800, background: '#ffffff',
    objects: [
      { id: 'headline', type: 'text', x: 0, y: 0, width: 800, height: 120, fontSize: 72, text: 'Ride for less', color: '#111111', align: 'left', font: 'sans' },
      { id: 'keret', type: 'rect', x: 10, y: 10, width: 200, height: 100, fill: '#eeeeee', radius: 0 },
    ],
  }
  const CANVAS_OK = {
    canvas: DOC, exists: true, rel: 'Projektek/teszt/nyari-plakat.canvas.json',
    name: 'nyari-plakat.canvas.json', version_id: 'v2', version_no: 2,
    limits: { max_objects: 200, text_max: 2000 }, summary: '2 elem',
  }

  /** A `canvas` a rajz vegpont valasza, a `project` a projekt (archivalashoz). */
  async function open(canvas: unknown = CANVAS_OK, status = 200, project: unknown = PROJECT) {
    h.respond((url) => {
      if (url.indexOf('/canvas/ops') > 0) {
        return { status: 201, body: { ok: true, canvas: DOC, item: GRAPHIC, applied: [], versions: [], message: 'Mentve' } }
      }
      if (url.indexOf('/canvas') > 0) return { status, body: canvas }
      if (url.indexOf('/preview') > 0) {
        return { status: 200, body: { available: true, kind: 'canvas', mime: 'image/svg+xml', name: 'nyari-plakat.canvas.json', rel: 'Projektek/teszt/nyari-plakat.canvas.json', reason: null, message: null, url: null } }
      }
      if (url.indexOf('/api/workbench/items/') === 0) {
        return { status: 200, body: { item: GRAPHIC, versions: [], parts: [], part_kinds: ['text', 'image'], project } }
      }
      return { status: 200, body: { project, items: [GRAPHIC], types: ['graphic'], statuses: ['draft'] } }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('wb-can-objs'))
  }

  function opsCalls() {
    return h.fetchCalls.filter((c) => c.url.indexOf('/canvas/ops') > 0)
  }

  function lastOps() {
    const calls = opsCalls()
    return JSON.parse(String(calls[calls.length - 1].init!.body)).ops
  }

  it('a kep FOLOTT elemenkent egy doboz all, szazalekos helyen', async () => {
    await open()
    const html = h.rootEl.innerHTML
    expect(html).toContain('class="wb-can-stage" data-wb-stage="1"')
    expect(html).toContain('data-wb-box="headline"')
    expect(html).toContain('data-wb-box="keret"')
    // 800/1000 = 80% szeles, 120/800 = 15% magas -- a kep barmekkora lehet.
    expect(html).toContain('left:0%;top:0%;width:80%;height:15%')
    // A KEPET tovabbra is a szerver rajzolja: ez a huzogatas ARA nem lehet.
    expect(html).toContain('/api/workbench/items/w1/canvas.svg')
    // Mind a negy sarok megfoghato.
    for (const g of ['nw', 'ne', 'sw', 'se']) expect(html).toContain('data-wb-grip="' + g + '"')
  })

  it('HUZAS: kozben NINCS halozati keres, elengedeskor PONTOSAN EGY update megy', async () => {
    await open()
    const before = opsCalls().length
    // 25 kepernyo-pixel jobbra, 10 le. A vaszon 1000x800, a kep 500x400:
    // minden kepernyo-pixel KET vaszon-egyseg.
    const probe = h.drag('headline', 25, 10, { steps: 4 })
    // A doboz MAR huzas kozben is a helyen van -- de ez csak a kepernyon.
    expect(probe.box.style.left).toBe('5%')
    await vi.waitFor(() => expect(opsCalls().length).toBe(before + 1))
    expect(lastOps()).toEqual([{ op: 'update', id: 'headline', patch: { x: 50, y: 20, width: 800, height: 120 } }])
  })

  it('SAROK: atmeretezeskor az ATELLENES sarok helyben marad', async () => {
    await open()
    // Bal felso sarok befele: a jobb also sarok (800,120) NEM mozdulhat.
    h.drag('headline', 25, 10, { grip: 'nw', steps: 3 })
    await vi.waitFor(() => expect(opsCalls().length).toBe(1))
    const patch = lastOps()[0].patch
    expect(patch).toEqual({ x: 50, y: 20, width: 750, height: 100 })
    expect(patch.x + patch.width).toBe(800)
    expect(patch.y + patch.height).toBe(120)
  })

  it('SAROK: a jobb also sarokkal nagyobbra huzva a bal felso marad helyben', async () => {
    await open()
    h.drag('headline', 25, 10, { grip: 'se', steps: 3 })
    await vi.waitFor(() => expect(opsCalls().length).toBe(1))
    expect(lastOps()[0].patch).toEqual({ x: 0, y: 0, width: 850, height: 140 })
  })

  it('a doboz nem tunhet el: nagyon kicsire huzva is marad belole valami', async () => {
    await open()
    h.drag('keret', -300, -300, { grip: 'se', steps: 3 })
    await vi.waitFor(() => expect(opsCalls().length).toBe(1))
    const patch = lastOps()[0].patch
    expect(patch.width).toBe(8)
    expect(patch.height).toBe(8)
    // A megfogott sarokkal szembeni pont helyben maradt.
    expect(patch.x).toBe(10)
    expect(patch.y).toBe(10)
  })

  it('KATTINTAS huzas nelkul csak kijelol -- nem kuld muveletet', async () => {
    await open()
    h.drag('keret', 0, 0)
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('wb-can-box-sel'))
    expect(opsCalls()).toHaveLength(0)
    expect(h.rootEl.innerHTML).toContain('data-wb-box="keret"')
  })

  it('MEGSZAKITOTT huzas (pointercancel) NEM ment', async () => {
    await open()
    h.drag('headline', 40, 40, { cancel: true })
    expect(opsCalls()).toHaveLength(0)
  })

  it('NYILBILLENTYU: eger nelkul is mozdul, Shift-tel nagyobbat', async () => {
    await open()
    h.arrow('headline', 'ArrowRight')
    await vi.waitFor(() => expect(opsCalls().length).toBe(1))
    expect(lastOps()).toEqual([{ op: 'move', id: 'headline', dx: 10, dy: 0 }])
  })

  it('NYILBILLENTYU Shift-tel: nagyobb lepes', async () => {
    await open()
    h.arrow('keret', 'ArrowUp', true)
    await vi.waitFor(() => expect(opsCalls().length).toBe(1))
    expect(lastOps()).toEqual([{ op: 'move', id: 'keret', dx: 0, dy: -50 }])
  })

  it('ARCHIVALT projekt: nincs doboz, es KIMONDJUK, miert', async () => {
    await open(CANVAS_OK, 200, { ...PROJECT, archived: 1 })
    const html = h.rootEl.innerHTML
    expect(html).not.toContain('data-wb-box=')
    expect(html).toContain('workbench.canvas.drag_archived')
    // A kep tovabbra is latszik.
    expect(html).toContain('/api/workbench/items/w1/canvas.svg')
  })

  it('ha a rajz adatai NEM toltodtek be, nincs doboz -- es megmondjuk a MASIK utat', async () => {
    h.respond((url) => {
      if (url.indexOf('/canvas') > 0) {
        return { status: 409, body: { error: 'canvas_no_depot', message: 'A rajz fájljához nem látok oda.', detail: 'x' } }
      }
      if (url.indexOf('/preview') > 0) {
        return { status: 200, body: { available: true, kind: 'canvas', mime: 'image/svg+xml', name: 'x.canvas.json', rel: 'x', reason: null, message: null, url: null } }
      }
      if (url.indexOf('/api/workbench/items/') === 0) {
        return { status: 200, body: { item: GRAPHIC, versions: [], parts: [], part_kinds: [], project: PROJECT } }
      }
      return { status: 200, body: { project: PROJECT, items: [GRAPHIC], types: ['graphic'], statuses: ['draft'] } }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('workbench.canvas.drag_unavailable'))
    const html = h.rootEl.innerHTML
    expect(html).not.toContain('data-wb-box=')
    // A kep attol meg ott van, es a hiba oka is ki van mondva.
    expect(html).toContain('/api/workbench/items/w1/canvas.svg')
    expect(html).toContain('A rajz fájljához nem látok oda.')
  })

  it('a huzas utan a kep egy pillanatra sem tunik el (nincs villogas)', async () => {
    await open()
    const mark = h.renders.length
    h.drag('keret', 30, 20)
    await vi.waitFor(() => expect(opsCalls().length).toBe(1))
    // Megvarjuk a TELJES kort: mentes kozbeni rajzolas, mentes utani rajzolas,
    // majd a friss elonezet rajzolasa.
    await vi.waitFor(() => expect(h.renders.length - mark).toBeGreaterThanOrEqual(3))
    const after = h.renders.slice(mark)
    // Tobbszor is ujrarajzolunk (mentes kozben, mentes utan) -- de a kep MINDEN
    // kozbenso allapotban ott van. Kulonben a masodik huzast el sem lehetne
    // kezdeni, mert a doboz eltunne a kez alol.
    expect(after.length).toBeGreaterThan(1)
    // A KEP es a rajta ulo doboz-reteg is vegig a helyen van. (A vaszon-doboz
    // letoltes-linkje is tartalmazza a kep cimet, ezert a SZINPADRA merunk.)
    for (const html of after) {
      expect(html).toContain('data-wb-stage="1"')
      expect(html).toContain('data-wb-box="keret"')
    }
  })

  it('minden uj kepernyo-szoveg a t()-n megy at (HU/EN)', async () => {
    await open()
    const html = h.rootEl.innerHTML
    for (const key of ['workbench.canvas.drag_hint', 'workbench.canvas.drag_aria']) {
      expect(html).toContain(key)
    }
  })
})

// #359 (Boss 1249): "hol van az a munkadarab felsorolas ... ha raklikkel a
// 6-os munkadarabra, akkor az aktualis munka a 6-os lesz, es bejon kozepen".
describe('munkadarabok kozti valtas (#359)', () => {
  const ITEMS = [1, 2, 3].map((n) => ({ id: 'w' + n, title: 'Darab ' + n, type: 'note', status: 'draft' }))

  beforeEach(async () => {
    h.respond((url) => {
      const m = url.match(/\/api\/workbench\/items\/(w\d)/)
      if (m) {
        const it = ITEMS.find((x) => x.id === m[1])
        return { status: 200, body: { item: it, versions: [], project: PROJECT } }
      }
      return { status: 200, body: itemsBody(ITEMS) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w3"'))
  })

  it('a lista szamozott, a fejlec mutatja a darabszamot, es van magyarazo sor', () => {
    const html = h.rootEl.innerHTML
    expect(html).toContain('1. Darab 1')
    expect(html).toContain('3. Darab 3')
    expect(html).toContain('⟦workbench.panel.items⟧ (3)')
    // Osztott nezetben (#406, 1. pont) a mondat a jobb oldalt nevezi meg.
    expect(html).toMatch(/⟦workbench\.items\.switch_hint(_split)?⟧/)
  })

  it('a listaban kattintott darab lesz az aktualis, es kozepen az nyilik meg', async () => {
    h.click({ 'data-wb-item': 'w2' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('<h3>Darab 2</h3>'))
    expect(h.rootEl.innerHTML).toMatch(/wb-item wb-item-active" data-wb-item="w2" aria-current="true"/)
    expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/w2'))).toBe(true)
  })

  it('a szerkeszto tetejen van valto: a legordulobol is lehet valtani', async () => {
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('<h3>Darab 1</h3>'))
    expect(h.rootEl.innerHTML).toContain('id="wbSwitch"')
    h.change('wbSwitch', [], 'w3')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('<h3>Darab 3</h3>'))
  })

  it('elozo/kovetkezo gomb a szomszedos darabra visz, a szelen letiltva', async () => {
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('<h3>Darab 1</h3>'))
    const sw = h.rootEl.innerHTML.slice(h.rootEl.innerHTML.indexOf('wb-switch'))
    // az elso darabnal nincs elozo, a kovetkezo a masodik
    expect(sw).toMatch(/data-wb-item="" disabled/)
    expect(sw).toContain('data-wb-item="w2"')
  })

  it('egyetlen darabnal nincs valto (nincs mire valtani)', async () => {
    h = harness()
    h.respond((url) => url.includes('/items/w1')
      ? { status: 200, body: { item: ITEMS[0], versions: [], project: PROJECT } }
      : { status: 200, body: itemsBody([ITEMS[0]]) })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('<h3>Darab 1</h3>'))
    expect(h.rootEl.innerHTML).not.toContain('id="wbSwitch"')
  })
})
