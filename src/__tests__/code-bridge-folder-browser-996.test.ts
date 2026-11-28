// #996: the folder browser of the code bridge window never showed a folder. cbFetch already returns the parsed
// body, and the poll called .json() on it again, so every good answer ended in "browsing failed".
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { PROJECT_ROOT } from '../config.js'

const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')

function fnSource(name: string): string {
  const m = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(app)
  expect(m, name).toBeTruthy()
  const rest = app.slice(m!.index)
  return rest.slice(0, rest.indexOf(`\n${m![1]}}\n`) + m![1].length + 3)
}

/** Runs the real poll with the real cbFetch over a faked network answer. */
async function poll(body: unknown, seen: { parent?: string } = {}) {
  const els = { box: { hidden: false }, list: { innerHTML: '' }, status: { textContent: 'cb.browse.waiting' } }
  const ctx = vm.createContext({
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }),
    cbBrowseEls: () => els,
    cbBrowseStop: () => {},
    t: (k: string) => k,
    escapeHtml: (s: unknown) => String(s),
    escapeAttr: (s: unknown) => String(s),
    setTimeout: () => 0,
  })
  vm.runInContext(`let _cbBrowseTimer = null\nlet _cbBrowseParent = ''\nlet _cbBrowseRun = 0\n${fnSource('cbFetch')}\n${fnSource('cbBrowsePoll')}\ncbBrowsePoll('abc')`, ctx)
  await new Promise((r) => setImmediate(r))
  seen.parent = vm.runInContext('_cbBrowseParent', ctx)
  return els
}

describe('code bridge folder browser (#996)', () => {
  it('lists the folders the worker reported', async () => {
    const els = await poll({ status: 'done', entries: [{ name: 'tozsde', path: 'F:\\tozsde', isRepo: true }] })
    expect(els.status.textContent).toBe('')
    expect(els.list.innerHTML).toContain('data-path="F:\\tozsde"')
    expect(els.list.innerHTML).toContain('cb.browse.repo')
  })

  it('says an empty folder is empty, not that browsing failed', async () => {
    expect((await poll({ status: 'done', entries: [] })).status.textContent).toBe('cb.browse.empty')
  })

  it('says when no worker answers', async () => {
    expect((await poll({ status: 'no_worker' })).status.textContent).toBe('cb.browse.no_worker')
  })
})

// The path line is cut at its start (right-to-left box), so the path itself has to stay left-to-right:
// otherwise "F:\\" is painted as "\\:F".
describe('#996 folder browser path line', () => {
  it('isolates the path as left-to-right inside the right-to-left box', () => {
    const html = readFileSync(join(PROJECT_ROOT, 'web', 'index.html'), 'utf8')
    expect(html).toContain('<code class="cb-browse-path"><bdi id="cbBrowsePath" dir="ltr"></bdi></code>')
  })
})

describe('#996 folder browser Up button', () => {
  it('goes to the parent the server answered, so the drive root is not skipped', async () => {
    const seen: { parent?: string } = {}
    await poll({ status: 'done', entries: [], parent: 'F:\\' }, seen)
    expect(seen.parent).toBe('F:\\')
    const at = app.indexOf("if (tgt.id === 'cbBrowseUp')")
    const handler = app.slice(at, app.indexOf("if (tgt.id === 'cbBrowsePick')", at))
    expect(handler).toContain('cbBrowseOpen(_cbBrowseParent)')
  })
})

// Two quick clicks (or a slow machine): the answer for the folder left behind arrived after the newer one was
// asked for, painted the old list under the new path and stopped the newer poll.
describe('#996 folder browser, late answer of an earlier folder', () => {
  /** The real open/poll/stop functions; every network call waits until the test answers it. */
  function browser() {
    const els = { box: { hidden: false }, list: { innerHTML: '' }, status: { textContent: '' }, pathEl: { textContent: '' }, up: { disabled: false } }
    const calls: { url: string; answer: (body: unknown) => Promise<void>; fail: () => Promise<void> }[] = []
    const settle = () => new Promise<void>((r) => setImmediate(r))
    const ctx = vm.createContext({
      fetch: (url: string) => new Promise((resolve, reject) => {
        calls.push({
          url,
          answer: async (body) => { resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) }); await settle() },
          fail: async () => { reject(new Error('network down')); await settle() },
        })
      }),
      cbBrowseEls: () => els,
      t: (k: string) => k,
      escapeHtml: (s: unknown) => String(s),
      escapeAttr: (s: unknown) => String(s),
      setTimeout: () => 1,
      clearTimeout: () => {},
    })
    const state = app.slice(app.indexOf("let _cbBrowsePath = ''"), app.indexOf('function cbBrowseEls('))
    vm.runInContext([state, ...['cbFetch', 'cbPostJson', 'cbBrowseStop', 'cbBrowseOpen', 'cbBrowsePoll'].map(fnSource)].join('\n'), ctx)
    const open = async (path: string) => { vm.runInContext(`cbBrowseOpen(${JSON.stringify(path)})`, ctx); await settle() }
    return { els, calls, open }
  }
  const listOf = (name: string) => ({ status: 'ok', entries: [{ name, path: `F:\\${name}`, isRepo: false }] })

  it('ignores the late list of the earlier folder', async () => {
    const b = browser()
    await b.open('F:\\old')
    await b.calls[0].answer({ id: 'old' }) // calls[1]: poll of the old folder, still on its way
    await b.open('F:\\new')
    await b.calls[2].answer({ id: 'new' })
    await b.calls[3].answer(listOf('new-child'))
    await b.calls[1].answer(listOf('old-child'))
    expect(b.els.list.innerHTML).toContain('new-child')
    expect(b.els.list.innerHTML).not.toContain('old-child')
  })

  it('does not start polling for a folder that was left before its request was accepted', async () => {
    const b = browser()
    await b.open('F:\\old')
    await b.open('F:\\new')
    await b.calls[1].answer({ id: 'new' })
    await b.calls[0].answer({ id: 'old' })
    expect(b.calls.map((c) => c.url).filter((u) => u.endsWith('/old'))).toEqual([])
  })

  it('keeps a late failure of the earlier folder off the screen', async () => {
    const b = browser()
    await b.open('F:\\old')
    await b.calls[0].answer({ id: 'old' })
    await b.open('F:\\new')
    await b.calls[1].fail()
    expect(b.els.status.textContent).toBe('cb.browse.waiting')
  })
})

const worker = readFileSync(join(PROJECT_ROOT, 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8')

// Measured on Windows PowerShell 5.1: the list shows hidden folders (ProgramData, AppData), but opening one
// answered "Could not find item", because Get-Item skips hidden items without -Force.
describe('#996 worker: a listed hidden folder can be opened', () => {
  it('reads the opened folder and its children with -Force', () => {
    const at = worker.indexOf('function Invoke-BrowseRequests')
    const fn = worker.slice(at, worker.indexOf('function Close-RequestedSessions', at))
    const reads = fn.split('\n').filter((l) => /Get-(Item|ChildItem) -LiteralPath/.test(l))
    expect(reads).toHaveLength(2)
    for (const line of reads) expect(line).toContain('-Force')
  })
})

// While a development task runs, the main lane reports only about once a minute (after a discovery pass), so a
// browse request expired before it was picked up. The idle chat lane asks every few seconds.
describe('#996 worker: browsing works while a task runs', () => {
  it('lets both lanes answer a browse request of the claim answer', () => {
    expect(worker).toMatch(/if \(\$claim -and \$claim\.browseRequests\) \{\r?\n        Invoke-BrowseRequests/)
    expect(worker).not.toMatch(/IsChatLane\)[^\r\n]*\$claim\.browseRequests/)
  })
})
