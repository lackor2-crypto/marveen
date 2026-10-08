/**
 * #482 -- A DASHBOARD LISTAI MEGORZIK A GORGETEST UJRARAJZOLASKOR.
 *
 * Boss (TG 7716): a gorgetosav visszaugrik az elejere, amikor egy lista
 * ujrarajzolodik. A Munkapad (workbench-scroll-preserve.test.ts) es a kanban
 * mar kesz; ez a web/app.js tobbi listajat fedi: EGY kozos helper
 * (preserveScroll / preserveScrollBegin), bekotve minden listaba, ami pollra
 * vagy kattintasra innerHTML-cserevel ujrarajzol.
 *
 * Ket reteg:
 *   1. VISELKEDES -- a VALODI helper-kod fut egy kis DOM-utanzaton: a
 *      gorgetes (top ES left) visszaall azonos nezetnel, NEM all vissza
 *      nezetvaltasnal / lapvaltasnal / a tulajdonos sajat gorgetese utan, es a
 *      kesobb kirajzolodo tartalomnak a kovetkezo frame-ben is visszaall.
 *   2. FORRAS-SZERZODES -- minden bekotott lista a helpert hasznalja, a
 *      szandekos aljara-gorgetes (chat) es a kanban drag-drop nem.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync('web/app.js', 'utf8')

/** A function's source, from its head to the next declaration at the same indent. */
function fnSrc(head: string, indent = ''): string {
  const i = app.indexOf(head)
  if (i < 0) throw new Error('missing: ' + head)
  const re = new RegExp('\\n' + indent + '(?:async )?function [A-Za-z_$]', 'g')
  re.lastIndex = i + head.length
  const m = re.exec(app)
  return app.slice(i, m ? m.index : app.length)
}

// ---- 1. the real helper on a tiny DOM -------------------------------------------

let ROOT: FakeEl | null = null

class FakeEl {
  tagName: string
  id: string
  className: string
  dataset: Record<string, string>
  nodeType = 1
  parentElement: FakeEl | null = null
  children: FakeEl[] = []
  hidden = false
  scrollHeight = 0
  clientHeight = 0
  scrollWidth = 0
  clientWidth = 0
  private top = 0
  private left = 0
  constructor(tag: string, o: { id?: string; cls?: string; data?: Record<string, string> } = {}) {
    this.tagName = tag.toUpperCase()
    this.id = o.id || ''
    this.className = o.cls || ''
    this.dataset = o.data || {}
  }
  // Like a browser: the offset is clamped to the scrollable range.
  get scrollTop() { return this.top }
  set scrollTop(v: number) { this.top = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - this.clientHeight))) }
  get scrollLeft() { return this.left }
  set scrollLeft(v: number) { this.left = Math.max(0, Math.min(v, Math.max(0, this.scrollWidth - this.clientWidth))) }
  /** What layout does when the content shrinks: the offset clamps. */
  relayout() { this.scrollTop = this.top; this.scrollLeft = this.left }
  append(c: FakeEl) { c.parentElement = this; this.children.push(c); return c }
  clear() { for (const c of this.children) c.parentElement = null; this.children = [] }
  get previousElementSibling() {
    const p = this.parentElement
    if (!p) return null
    const i = p.children.indexOf(this)
    return i > 0 ? p.children[i - 1] : null
  }
  get isConnected() {
    let n: FakeEl = this
    while (n.parentElement) n = n.parentElement
    return n === ROOT
  }
  getClientRects() { return this.hidden ? [] : [{}] }
  querySelectorAll(sel: string) {
    if (sel !== '*') throw new Error('only * is faked')
    const out: FakeEl[] = []
    const walk = (n: FakeEl) => { for (const c of n.children) { out.push(c); walk(c) } }
    walk(this)
    return out
  }
}

function loadHelper() {
  const start = app.indexOf('// === #482: a list redrawn in place keeps its scroll position ===')
  const endHead = app.indexOf('function preserveScroll(container, renderFn, opts) {')
  expect(start).toBeGreaterThan(-1)
  expect(endHead).toBeGreaterThan(start)
  const end = app.indexOf('\n}\n', endHead) + 2
  const listeners: Record<string, (e: any) => void> = {}
  const frames: Array<() => void> = []
  const win = { addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn } }
  const api = new Function('window', 'requestAnimationFrame',
    app.slice(start, end) + '\nreturn { preserveScroll, preserveScrollBegin, bumpPage: () => { _scrollPageEpoch++ } }',
  )(win, (cb: () => void) => { frames.push(cb) })
  return {
    ...api,
    fire: (type: string, target: any = { closest: () => null }) => listeners[type]?.({ type, target }),
    flushFrames: () => { while (frames.length) frames.shift()!() },
  }
}

/** html (the window scroller) > main > list > box[data-acc=a] (a scrolling inner box). */
function page() {
  const html = new FakeEl('html')
  ROOT = html
  Object.assign(html, { scrollHeight: 3000, clientHeight: 800 })
  const main = html.append(new FakeEl('main'))
  const list = main.append(new FakeEl('div', { cls: 'drive-list' }))
  const box = () => Object.assign(new FakeEl('section', { cls: 'drive-col', data: { acc: 'a' } }), {
    scrollHeight: 500, clientHeight: 100, scrollWidth: 400, clientWidth: 200,
  })
  const first = list.append(box())
  return { html, list, first, box }
}

/** A redraw the way the dashboard does it: the list empties (the page collapses
 *  and the window clamps), then the same tree is built again. */
function redraw(p: ReturnType<typeof page>, lateLayout = false) {
  p.list.clear()
  p.html.scrollHeight = 900
  p.html.relayout()
  const fresh = p.list.append(p.box())
  if (lateLayout) { fresh.scrollHeight = 50; fresh.scrollWidth = 150 } else p.html.scrollHeight = 3000
  return fresh
}

describe('#482 preserveScroll -- the real helper', () => {
  it('a same-view redraw puts back the window AND the inner box, top and left', () => {
    const h = loadHelper()
    const p = page()
    h.preserveScroll(p.list, () => {}) // first draw: only registers the view
    p.html.scrollTop = 900
    p.first.scrollTop = 120
    p.first.scrollLeft = 30
    let fresh: FakeEl | null = null
    h.preserveScroll(p.list, () => { fresh = redraw(p) })
    expect(p.html.scrollTop).toBe(900)
    expect(fresh!.scrollTop).toBe(120)
    expect(fresh!.scrollLeft).toBe(30)
  })

  it('without the helper the same redraw loses both (the bug this fixes)', () => {
    const p = page()
    p.html.scrollTop = 900
    p.first.scrollTop = 120
    const fresh = redraw(p)
    expect(p.html.scrollTop).toBe(100)
    expect(fresh.scrollTop).toBe(0)
  })

  it('content that lays out late is put back on the next frame', () => {
    const h = loadHelper()
    const p = page()
    h.preserveScroll(p.list, () => {})
    p.html.scrollTop = 900
    p.first.scrollTop = 120
    p.first.scrollLeft = 30
    let fresh: FakeEl | null = null
    h.preserveScroll(p.list, () => { fresh = redraw(p, true) })
    expect(p.html.scrollTop).toBe(100) // still clamped: the page is short yet
    p.html.scrollHeight = 3000
    fresh!.scrollHeight = 500
    fresh!.scrollWidth = 400
    h.flushFrames()
    expect(p.html.scrollTop).toBe(900)
    expect(fresh!.scrollTop).toBe(120)
    expect(fresh!.scrollLeft).toBe(30)
  })

  it('the next-frame pass never pulls back a box that moved on', () => {
    const h = loadHelper()
    const p = page()
    h.preserveScroll(p.list, () => {})
    p.html.scrollTop = 900
    h.preserveScroll(p.list, () => { redraw(p) })
    p.html.scrollTop = 1500
    h.flushFrames()
    expect(p.html.scrollTop).toBe(1500)
  })

  it('an async redraw (loading placeholder, then the data) is restored when it settles', async () => {
    const h = loadHelper()
    const p = page()
    h.preserveScroll(p.list, () => {})
    p.html.scrollTop = 900
    await h.preserveScroll(p.list, async () => {
      p.list.clear()
      p.html.scrollHeight = 900
      p.html.relayout()
      await Promise.resolve()
      p.list.append(p.box())
      p.html.scrollHeight = 3000
    })
    expect(p.html.scrollTop).toBe(900)
  })

  it('the two-phase form does the same for a loader spread around an await', () => {
    const h = loadHelper()
    const p = page()
    h.preserveScrollBegin(p.list, { view: 'f1' })
    p.html.scrollTop = 900
    const done = h.preserveScrollBegin(p.list, { view: 'f1' })
    redraw(p)
    done()
    expect(p.html.scrollTop).toBe(900)
  })

  it('another view (folder, tab, filter) is a real navigation: not restored', () => {
    const h = loadHelper()
    const p = page()
    h.preserveScroll(p.list, () => {}, { view: 'folder-1' })
    p.html.scrollTop = 900
    h.preserveScroll(p.list, () => { redraw(p) }, { view: 'folder-2' })
    expect(p.html.scrollTop).toBe(100)
  })

  it('a page switch since the last draw is a real navigation: not restored', () => {
    const h = loadHelper()
    const p = page()
    h.preserveScroll(p.list, () => {})
    h.bumpPage()
    p.html.scrollTop = 900
    h.preserveScroll(p.list, () => { redraw(p) })
    expect(p.html.scrollTop).toBe(100)
  })

  it("the owner's own scrolling during an async load wins", () => {
    const h = loadHelper()
    const p = page()
    h.preserveScrollBegin(p.list)
    p.html.scrollTop = 900
    const done = h.preserveScrollBegin(p.list)
    redraw(p)
    h.fire('wheel')
    done()
    expect(p.html.scrollTop).toBe(100)
  })

  it('typing into a field is not counted as scrolling', () => {
    const h = loadHelper()
    const p = page()
    h.preserveScrollBegin(p.list)
    p.html.scrollTop = 900
    const done = h.preserveScrollBegin(p.list)
    redraw(p)
    h.fire('keydown', { closest: (sel: string) => (sel.includes('input') ? {} : null) })
    done()
    expect(p.html.scrollTop).toBe(900)
  })

  it('a hidden list (another page is open) still renders, but nothing is touched', () => {
    const h = loadHelper()
    const p = page()
    h.preserveScroll(p.list, () => {})
    p.list.hidden = true
    p.html.scrollTop = 900
    let ran = false
    h.preserveScroll(p.list, () => { ran = true; redraw(p) })
    expect(ran).toBe(true)
    expect(p.html.scrollTop).toBe(100)
  })

  it('a missing container is harmless', () => {
    const h = loadHelper()
    expect(h.preserveScroll(null, () => 7)).toBe(7)
    expect(() => h.preserveScrollBegin(undefined)()).not.toThrow()
  })
})

// ---- 2. source contract: who uses it, who does not --------------------------------

describe('#482 the helper is wired into the lists that redraw in place', () => {
  it('a page switch starts a new view', () => {
    expect(fnSrc('function switchPage(')).toMatch(/_scrollPageEpoch\+\+/)
  })

  it('the helper saves top AND left of the container, the boxes inside and around it', () => {
    const helper = app.slice(app.indexOf('function _scrollSnapshot('), app.indexOf('function _scrollApply('))
    expect(helper).toMatch(/for \(let n = container; n && n\.nodeType === 1; n = n\.parentElement\)/)
    expect(helper).toMatch(/container\.querySelectorAll\('\*'\)/)
    expect(helper).toMatch(/top: n\.scrollTop, left: n\.scrollLeft/)
    expect(fnSrc('function preserveScrollBegin(')).toMatch(/requestAnimationFrame\(/)
  })

  const wired: Array<[string, RegExp, string?]> = [
    ['async function loadAgents(', /preserveScroll\(agentsGrid, renderAgents\)/],
    ['async function loadActivity(', /preserveScroll\(document\.getElementById\('activityList'\), \(\) => renderActivity\(entries\)\)/],
    ['async function loadSchedules(', /preserveScroll\(document\.getElementById\('tasksPage'\), \(\) => \{\s*renderScheduleList\(shown\)/],
    ['async function _loadMemoriesPage(', /preserveScrollBegin\(memList, \{ view:[\s\S]*renderMemories\(memories, append\)[\s\S]*keepScroll\(\)/],
    ['async function loadDriveFolder(', /preserveScrollBegin\(list, \{ view: _driveAccount \+ '\\n' \+ folder\.id \}\)[\s\S]*keepScroll\(\)/],
    ['async function loadDriveColumn(', /preserveScrollBegin\(list, \{ view: folder\.id \}\)[\s\S]*keepScroll\(\)/],
    ['async function loadMegaFolder(', /preserveScrollBegin\(list, \{ view: account[\s\S]*keepScroll\(\)/],
    ['async function loadMegaColumn(', /preserveScrollBegin\(list, \{ view: stack[\s\S]*keepScroll\(\)/],
    ['async function _photosRefresh(', /preserveScrollBegin\(grid, \{ view: _photosAccount \}\)[\s\S]*keepScroll\(\)/],
    ['async function loadGitReposPage(', /preserveScroll\(host, \(\) => _gitreposRenderList\(data\)\)/],
    ['function _renderApprovalsTable(', /preserveScroll\(document\.getElementById\('approvalsTable'\)\?\.parentElement, _renderApprovalsTableNow, \{ view \}\)/],
    ['async function _prjLoadList(', /preserveScrollBegin\(root, \{ view: 'list' \}\)[\s\S]*_prjRenderList\(\)\s*keepScroll\(\)/],
    ['function _prjRenderList(', /preserveScroll\(root, \(\) => \{[\s\S]*\}, \{ view: 'list' \}\)/],
    ['function _prjRenderProject(', /preserveScrollBegin\(root, \{ view: p\.id \+ '\\n' \+ _prj\.tab \}\)[\s\S]*keepScroll\(\)/],
    ['async function loadBgTasks(', /preserveScrollBegin\(list, \{ view:[\s\S]*keepScroll\(\)/],
    ['  async function cbRefresh(', /preserveScrollBegin\(document\.getElementById\('cbModalBody'\), \{ view: _cbTab \}\)[\s\S]*keepScroll\(\)/, '  '],
  ]
  for (const [head, re, indent] of wired) {
    it(head.trim() + ' uses it', () => {
      expect(fnSrc(head, indent || '')).toMatch(re)
    })
  }

  it('an edit or a delete reloads as many memories as were on screen', () => {
    expect(fnSrc('async function _loadMemoriesPage(')).toMatch(/Math\.min\(MEM_KEEP_MAX, Math\.max\(MEM_PAGE, _memNextOffset\)\)/)
    expect(app.match(/loadMemories\(\{ keep: true \}\)/g)?.length).toBe(2)
  })

  it('the deliberate jumps stay untouched: chat stick-to-bottom and the kanban drag-drop', () => {
    for (const head of ['async function fetchChatPage(', 'function renderChatBubbles(', 'function convAppendRows(',
      'function renderConversation(', 'function renderConvEntry(', 'function wireKanbanColumnDnD(']) {
      // (renderConversation has its own, older `opts.preserveScroll` switch -- a call is what must not appear)
      expect(fnSrc(head), head).not.toMatch(/preserveScroll(?:Begin)?\(/)
    }
  })
})

// ---- the background-task list: found while wiring it ------------------------------

describe('#482 background tasks: a listed task renders (the t() translator is not shadowed)', () => {
  it('one task shows its row and status label, not the load error', async () => {
    const i = app.indexOf('async function loadBgTasks(')
    const body = app.slice(i, app.indexOf('\n}', i) + 2)
    const list = { innerHTML: '' }
    const doc = { getElementById: (id: string) => (id === 'bgTasksList' ? list : id === 'bgShowAll' ? { checked: false } : { value: '' }) }
    const fetchStub = async () => ({ ok: true, json: async () => [{ id: 'bg1', status: 'done', agent_id: 'a1', started_label: 's', prompt: 'p1', output: 'o1' }] })
    const load = new Function('document', 'fetch', 't', 'esc', 'preserveScrollBegin', body + '\nreturn loadBgTasks')(
      doc, fetchStub, (k: string) => 'T:' + k, (s: unknown) => String(s), () => () => {},
    )
    await load()
    expect(list.innerHTML).not.toContain('T:bgTasks.load_error')
    expect(list.innerHTML).toContain('T:bgTasks.status.done')
    expect(list.innerHTML).toContain('bg1')
    expect(list.innerHTML).toContain('p1')
  })
})
