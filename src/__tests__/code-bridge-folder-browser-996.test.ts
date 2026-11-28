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
async function poll(body: unknown) {
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
  vm.runInContext(`let _cbBrowseTimer = null\n${fnSource('cbFetch')}\n${fnSource('cbBrowsePoll')}\ncbBrowsePoll('abc')`, ctx)
  await new Promise((r) => setImmediate(r))
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
