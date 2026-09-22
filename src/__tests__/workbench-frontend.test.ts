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
  /** Fajlvalaszto: a VALODI `change`-figyelot szolaltatja meg. */
  change: (id: string, files: unknown[]) => void
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
  const changeHandlers: Handler[] = []
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
      if (type === 'change') changeHandlers.push(fn)
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
    respond(fn) { responder = fn },
    click(attrs) { for (const h of clickHandlers) h(eventFor(attrs)) },
    change(id, files) {
      const e = { target: { id, files, value: '' }, preventDefault() {} }
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
        return { status: 200, body: sse([{ type: 'session', sessionId: 's1' }, { type: 'text', text: 'Rendben, ' }, { type: 'text', text: 'megcsinálom.' }, { type: 'done', model: 'claude-sonnet-5' }]) }
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

  it('a kulcs-beallito urlap a feluletrol menti a kulcsot, es nem visszhangozza', async () => {
    await openChat()
    h.respond((url) => {
      if (url.indexOf('/api/workbench/agent/config') >= 0) return { status: 200, body: { WORKBENCH_MODEL: '', keyConfigured: false } }
      if (url.indexOf('/api/workbench/agent/status') >= 0) return { status: 200, body: { provider: { available: false, message: 'Nincs beállítva AI-szolgáltató.' }, usage: { usedPct: null, measured: false }, allowed: true } }
      return { status: 200, body: itemsBody([]) }
    })
    h.click({ 'data-wb-act': 'chat-setup' })
    await vi.waitFor(() => expect(h.rootEl.innerHTML).toContain('id="wbChatSetup"'))
    // A kulcs mezo URES: a meglevo kulcs sosem jon vissza a feluletre.
    expect(h.rootEl.innerHTML).toMatch(/id="wbChatKey"[^>]*type="password"/)
    expect(h.rootEl.innerHTML).not.toContain('sk-ant-valodi')

    h.inputs.wbChatKey = { value: 'sk-ant-uj-kulcs', focus() {} }
    h.inputs.wbChatModel = { value: 'claude-sonnet-5', focus() {} }
    h.click({ 'data-wb-act': 'chat-setup-save' })
    await vi.waitFor(() => {
      const post = h.fetchCalls.find((c) => c.url.indexOf('/api/workbench/agent/config') >= 0 && c.init && c.init.method === 'POST')
      expect(post).toBeTruthy()
      expect(JSON.parse(String(post?.init?.body)).WORKBENCH_ANTHROPIC_API_KEY).toBe('sk-ant-uj-kulcs')
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
    expect(html).toContain('/api/life/file?path=' + encodeURIComponent('Projektek/teszt/foto.jpg'))
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
