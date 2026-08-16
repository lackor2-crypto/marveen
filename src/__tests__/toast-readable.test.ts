// A toast must stay long enough to be READ, and the reader must be able to
// dismiss it.
//
// Boss, 2026-08-15: "lent megjelenik egy iras de annyira hamar eltunik hogy el
// sem lehet olvasni [...] azert legyen mar kint legalabb egy darabig. de
// megjobb lenne ha egy x el csak kixelnem en."
//
// Three separate defects produced that one experience, and each is guarded here
// because each can come back on its own:
//
//   1. A flat 3000 ms default. The message that triggered the report
//      ('memories.toast.vector_none') is 111 characters of Hungarian prose --
//      unreadable in three seconds. The dwell time is now derived from the
//      length of the text.
//   2. `white-space: nowrap` on .toast. Even a toast that STAYED was unreadable,
//      because a long line ran off both edges of a viewport-centred box. Nothing
//      in the UI reported this; it just looked like a clipped flash.
//   3. Ten call sites passed the wrong second argument -- `true` (from
//      `setTimeout(fn, true)` -> 1 ms) or the string 'error' (-> NaN -> 0 ms).
//      Those toasts were mathematically invisible, and they were the FAILURE
//      messages: "Reconnect sikertelen", "Smoke-test hiba", save errors. A
//      wrong second argument must never again be able to hide a message, so
//      showToast normalises whatever it is handed instead of trusting it.
//
// web/app.js is a classic script with no module boundary, so the function is
// brace-matched out of the source and evaluated against a DOM stub (the idiom
// from accounts-one-panel.test.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const css = readFileSync(join(WEB, 'style.css'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() not found in web/app.js`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() is not brace-balanced`)
}

interface StubEl {
  className: string
  textContent: string
  type?: string
  classes: Set<string>
  children: StubEl[]
  attrs: Record<string, string>
  listeners: Record<string, (() => void)[]>
  classList: {
    add: (c: string) => void
    remove: (c: string) => void
    toggle: (c: string, on: boolean) => void
    contains: (c: string) => boolean
  }
  setAttribute: (k: string, v: string) => void
  addEventListener: (ev: string, fn: () => void) => void
  append: (...els: StubEl[]) => void
  fire: (ev: string) => void
}

function makeEl(): StubEl {
  const el: Partial<StubEl> = {
    className: '',
    textContent: '',
    classes: new Set<string>(),
    children: [],
    attrs: {},
    listeners: {},
  }
  el.classList = {
    add: (c: string) => { el.classes!.add(c) },
    remove: (c: string) => { el.classes!.delete(c) },
    toggle: (c: string, on: boolean) => { on ? el.classes!.add(c) : el.classes!.delete(c) },
    contains: (c: string) => el.classes!.has(c),
  }
  el.setAttribute = (k: string, v: string) => { el.attrs![k] = v }
  el.addEventListener = (ev: string, fn: () => void) => {
    (el.listeners![ev] ||= []).push(fn)
  }
  el.append = (...els: StubEl[]) => {
    // textContent = '' is how showToast clears the box; mirror that here.
    for (const child of els) el.children!.push(child)
  }
  el.fire = (ev: string) => { for (const fn of el.listeners![ev] || []) fn() }
  return el as StubEl
}

interface Harness {
  showToast: (msg: unknown, opts?: unknown, big?: boolean) => void
  hideToast: () => void
  toastReadingMs: (text: string) => number
  toast: StubEl
  timers: { fn: () => void; ms: number; id: number }[]
  runTimer: (id: number) => void
}

// Rebuild the toast module in isolation: the element, the timer plumbing, and
// the two globals it reaches for (document.createElement, t()).
function harness(): Harness {
  const toast = makeEl()
  const timers: { fn: () => void; ms: number; id: number }[] = []
  let nextId = 1
  const setTimeoutStub = (fn: () => void, ms: number) => {
    const id = nextId++
    timers.push({ fn, ms, id })
    return id
  }
  const clearTimeoutStub = (id: number) => {
    const i = timers.findIndex((x) => x.id === id)
    if (i >= 0) timers.splice(i, 1)
  }
  const documentStub = { createElement: () => makeEl() }
  const src = [
    'let toastTimer = null',
    'let toastAutoMs = 0',
    extractFn(app, 'toastReadingMs'),
    extractFn(app, 'hideToast'),
    extractFn(app, 'showToast'),
    'return { showToast, hideToast, toastReadingMs }',
  ].join('\n')
  const built = new Function(
    'toast', 'setTimeout', 'clearTimeout', 'document', 't',
    src,
  )(toast, setTimeoutStub, clearTimeoutStub, documentStub, (k: string) => k) as {
    showToast: Harness['showToast']
    hideToast: Harness['hideToast']
    toastReadingMs: Harness['toastReadingMs']
  }
  return {
    ...built,
    toast,
    timers,
    runTimer: (id: number) => {
      const timer = timers.find((x) => x.id === id)
      if (!timer) throw new Error(`timer ${id} is gone`)
      clearTimeoutStub(id)
      timer.fn()
    },
  }
}

// The exact message from Boss's report: 111 characters.
const LONG = 'Egy vektor sem keszult: a helyi modell-szerver (Ollama) nem erheto el. A kereses kulcsszavakkal tovabb mukodik.'

describe('showToast dwell time', () => {
  it('never shows a message for less than four seconds', () => {
    const h = harness()
    h.showToast('OK')
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0].ms).toBeGreaterThanOrEqual(4000)
  })

  it('gives a long message proportionally longer than the old flat 3000 ms', () => {
    const h = harness()
    h.showToast(LONG)
    expect(LONG.length).toBeGreaterThan(100)
    expect(h.timers[0].ms).toBeGreaterThan(3000 * 2)
  })

  it('caps the dwell time so a pathological message cannot pin the box open', () => {
    const h = harness()
    h.showToast('x'.repeat(5000))
    expect(h.timers[0].ms).toBeLessThanOrEqual(20000)
  })

  it('honours an explicit longer duration as a floor, never as a ceiling', () => {
    const h = harness()
    h.showToast('rovid', 14000)
    expect(h.timers[0].ms).toBe(14000)
  })
})

describe('showToast argument normalisation', () => {
  // The regression that made ten failure messages invisible.
  it('treats a boolean second argument as "big", not as a 1 ms timeout', () => {
    const h = harness()
    h.showToast('Reconnect sikertelen', true)
    expect(h.toast.classList.contains('toast-big')).toBe(true)
    expect(h.timers[0].ms).toBeGreaterThanOrEqual(4000)
  })

  it("treats a string second argument as a type, not as a NaN timeout", () => {
    const h = harness()
    h.showToast('Mentes sikertelen', 'error')
    expect(h.toast.classList.contains('toast-error')).toBe(true)
    // An error is not dismissed on a timer at all.
    expect(h.timers).toHaveLength(0)
  })

  it('ignores a non-finite duration rather than producing an instant toast', () => {
    const h = harness()
    h.showToast('valami', Number.NaN)
    expect(h.timers[0].ms).toBeGreaterThanOrEqual(4000)
  })
})

describe('showToast dismissal', () => {
  it('puts a labelled close button on every toast', () => {
    const h = harness()
    h.showToast('barmi')
    const close = h.toast.children.find((c) => c.className === 'toast-close')
    expect(close).toBeTruthy()
    expect(close!.attrs['aria-label']).toBeTruthy()
    expect(close!.textContent).toBe('×')
  })

  it('hides the toast when the close button is clicked', () => {
    const h = harness()
    h.showToast('barmi')
    expect(h.toast.classList.contains('visible')).toBe(true)
    h.toast.children.find((c) => c.className === 'toast-close')!.fire('click')
    expect(h.toast.classList.contains('visible')).toBe(false)
    expect(h.timers).toHaveLength(0)
  })

  it('keeps an error on screen until it is closed by hand', () => {
    const h = harness()
    h.showToast('Smoke-test hiba', { type: 'error' })
    expect(h.timers).toHaveLength(0)
    expect(h.toast.classList.contains('toast-sticky')).toBe(true)
    h.toast.children.find((c) => c.className === 'toast-close')!.fire('click')
    expect(h.toast.classList.contains('visible')).toBe(false)
  })

  it('renders the message as text, so a message carrying markup cannot inject it', () => {
    const h = harness()
    h.showToast('<img src=x onerror=alert(1)>')
    const text = h.toast.children.find((c) => c.className === 'toast-text')
    expect(text!.textContent).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('showToast timer ownership', () => {
  // The silent one: an earlier toast's timer used to fire while a LATER toast
  // was on screen and wipe it, so a second message could vanish at once.
  it('an earlier toast cannot cancel a later one', () => {
    const h = harness()
    h.showToast('elso')
    const first = h.timers[0].id
    h.showToast('masodik')
    expect(h.timers.some((x) => x.id === first)).toBe(false)
    expect(h.timers).toHaveLength(1)
    expect(h.toast.classList.contains('visible')).toBe(true)
  })
})

describe('toast stylesheet', () => {
  function toastRule(): string {
    const start = css.indexOf('.toast {')
    expect(start).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start))
  }

  it('lets a long message wrap instead of running off both edges', () => {
    expect(toastRule()).not.toMatch(/white-space:\s*nowrap/)
    expect(toastRule()).toMatch(/max-width:/)
  })

  it('styles the close button so it is actually clickable', () => {
    expect(css).toMatch(/\.toast-close\s*\{/)
    expect(css.slice(css.indexOf('.toast-close {'))).toMatch(/cursor:\s*pointer/)
  })
})

// Boss, 2026-08-15: "amikor kixelem akkor lejebb megy ugyan az oldalon, de nem
// tunik el! ott marad allandoan."
//
// The hidden state used to be a single fixed offset, translateY(100px), and
// hideToast() only takes the .visible class off -- so a toast TALLER than
// 100 px kept its bottom on screen for good. Measured with Playwright on
// Boss's exact click path: 76 px left over at 1280x720, and 412 px on a
// 390x844 phone, sitting over the folder column. There
// elementFromPoint() on the middle of the "Spam- es promocio-szabalyok"
// button returned 'toast-text', and a real click did not open the dialog --
// which is where Boss's third report ("rakattintottam es nem csinal semmit")
// came from. One bug, two symptoms.
//
// A pixel offset can never hide a box of unknown height, so the hidden state
// must stop painting AND stop receiving clicks on its own. These three
// assertions guard exactly that, and the fourth stops a later rule from
// quietly handing the clicks back.
describe('a dismissed toast is really gone', () => {
  function ruleFor(selector: string): string {
    const start = css.indexOf(selector + ' {')
    expect(start).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start))
  }

  it('stops painting, whatever its height', () => {
    const rule = ruleFor('.toast')
    expect(rule).toMatch(/opacity:\s*0\b/)
    expect(rule).toMatch(/visibility:\s*hidden/)
  })

  it('does not swallow the click meant for what is underneath it', () => {
    expect(ruleFor('.toast')).toMatch(/pointer-events:\s*none/)
  })

  it('gets all three back when it is shown, or nothing would ever appear', () => {
    const rule = ruleFor('.toast.visible')
    expect(rule).toMatch(/opacity:\s*1\b/)
    expect(rule).toMatch(/visibility:\s*visible/)
    expect(rule).toMatch(/pointer-events:\s*auto/)
  })

  // Including inside a media query: the phone is where this hurt most.
  it('has no second .toast rule that hands the hidden bar its clicks back', () => {
    const offenders = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel, body]) => /(^|,)\s*\.toast\s*(,|$)/.test(sel) && /pointer-events:\s*auto/.test(body))
      .map(([, sel]) => sel.trim())
    expect(offenders).toEqual([])
  })
})
