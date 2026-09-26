// A Munkapad feluletenek (web/workbench.js) TENYLEGES futtatasa DOM-utanzattal.
//
// Ugyanaz a minta, mint a `workbench-frontend.test.ts`-ben: jsdom nincs a
// projektben, de a Munkapad-kod szandekosan keveset var a DOM-tol (egy
// `#projectsRoot` innerHTML + delegalt figyelok). Itt kozos helyen all, hogy a
// #406 pontjainak tesztjei ne masoljak egymasba ugyanazt az utanzatot.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')

type Handler = (e: unknown) => void

/** Egy valasz. A `stream` SSE-folyamot ad (agent-chat): a darabok egymas utan
 *  jonnek, es a folyam csak a `hold` teljesulese utan er veget -- igy merheto,
 *  mi tortenik a valasz KOZBEN. */
export interface Reply {
  status: number
  body: unknown
  stream?: { chunks: string[]; hold?: Promise<unknown> }
}

export interface FakeInput {
  value: string
  focus: () => void
  files?: unknown[]
}

export interface WorkbenchHarness {
  win: Record<string, any>
  rootEl: { innerHTML: string }
  html: () => string
  click: (attrs: Record<string, string>) => void
  change: (id: string, files: unknown[], value?: string) => void
  /** Barmely esemeny (dragover, drop, input, keydown ...) a delegalt figyeloknek. */
  fire: (type: string, event: Record<string, unknown>) => void
  fetchCalls: { url: string; init?: RequestInit }[]
  toasts: string[]
  inputs: Record<string, FakeInput>
  storage: Record<string, string>
  opened: string[]
  respond: (fn: (url: string, init?: RequestInit) => Reply) => void
  renders: string[]
}

/** Egy kattintas-esemeny: a `closest()` a megadott attributumokbol valaszol. */
export function eventFor(attrs: Record<string, string>) {
  const target = {
    closest(sel: string) {
      const name = sel.slice(1, -1)
      if (!(name in attrs)) return null
      return { getAttribute: (a: string) => (a in attrs ? attrs[a] : null) }
    },
    getAttribute: (a: string) => (a in attrs ? attrs[a] : null),
  }
  return { target, preventDefault() {}, stopPropagation() {} }
}

export function workbenchHarness(opts: { storage?: Record<string, string>; confirm?: boolean } = {}): WorkbenchHarness {
  const handlers: Record<string, Handler[]> = {}
  const renders: string[] = []
  const rootEl = {
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(v: string) { this._html = v; renders.push(v) },
  }
  const inputs: Record<string, FakeInput> = {}
  const toasts: string[] = []
  const opened: string[] = []
  const fetchCalls: { url: string; init?: RequestInit }[] = []
  const storage: Record<string, string> = { ...(opts.storage || {}) }
  let responder: (url: string, init?: RequestInit) => Reply = () => ({ status: 200, body: {} })

  const doc = {
    addEventListener(type: string, fn: Handler) { (handlers[type] = handlers[type] || []).push(fn) },
    getElementById(id: string) {
      if (id === 'projectsRoot') return rootEl
      return inputs[id] || null
    },
    querySelector() { return null },
  }

  const win: Record<string, any> = {
    _lang: 'hu',
    t: (key: string, params: Record<string, unknown> = {}) =>
      `⟦${key}${Object.keys(params).length ? ':' + JSON.stringify(params) : ''}⟧`,
    escapeHtml: (s: unknown) => String(s == null ? '' : s),
    escapeAttr: (s: unknown) => String(s == null ? '' : s),
    showToast: (m: string) => { toasts.push(m) },
    confirm: () => opts.confirm !== false,
    open: (url: string) => { opened.push(url); return null },
    localStorage: {
      getItem: (k: string) => (k in storage ? storage[k] : null),
      setItem: (k: string, v: string) => { storage[k] = String(v) },
    },
  }

  const fakeFetch = (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init })
    const r = responder(url, init)
    const isText = typeof r.body === 'string'
    let body: unknown = undefined
    if (r.stream) {
      const enc = new TextEncoder()
      const chunks = r.stream.chunks.slice()
      const hold = r.stream.hold || Promise.resolve()
      body = {
        getReader: () => ({
          read: () => chunks.length
            ? Promise.resolve({ done: false, value: enc.encode(chunks.shift()!) })
            : hold.then(() => ({ done: true, value: undefined })),
        }),
      }
    }
    return Promise.resolve({
      ok: r.status < 400,
      status: r.status,
      body,
      json: () => (isText ? Promise.reject(new Error('not json')) : Promise.resolve(r.body)),
      text: () => Promise.resolve(isText ? (r.body as string) : JSON.stringify(r.body)),
    })
  }

  // eslint-disable-next-line no-new-func
  new Function('document', 'window', 'fetch', 'TextDecoder', SRC)(doc, win, fakeFetch, TextDecoder)

  const fire = (type: string, event: Record<string, unknown>) => {
    for (const h of handlers[type] || []) h(event)
  }

  return {
    win,
    rootEl,
    html: () => rootEl.innerHTML,
    inputs,
    toasts,
    opened,
    storage,
    fetchCalls,
    renders,
    respond(fn) { responder = fn },
    click(attrs) { fire('click', eventFor(attrs)) },
    change(id, files, value = '') { fire('change', { target: { id, files, value }, preventDefault() {} }) },
    fire,
  }
}

export const PROJECT = { id: 'p1', name: 'Kovács weboldal', archived: false }

export function itemsBody(items: unknown[], project: Record<string, unknown> = PROJECT) {
  return { project, items, types: ['document', 'image', 'graphic', 'video', 'note', 'composite'], statuses: ['draft', 'in_progress', 'review', 'done'] }
}

/** A kepernyore kerulo, NEM a t()-n atment szoveg -- a felhasznalo/szerver
 *  sajat adatait (`allowed`) kiveve. Ekezetes betu itt = kezzel irt magyar. */
export function untranslatedHungarian(html: string, allowed: string[] = []): string {
  let visible = html.replace(/⟦[^⟧]*⟧/g, '').replace(/<[^>]*>/g, ' ')
  for (const a of allowed) visible = visible.split(a).join('')
  const m = visible.match(/[^\s]*[áéíóöőúüűÁÉÍÓÖŐÚÜŰ][^\s]*/g)
  return m ? m.join(' ') : ''
}
