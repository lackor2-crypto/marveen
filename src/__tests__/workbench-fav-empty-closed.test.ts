// TG 3131: the Favorites folder starts closed while it is empty and open once it holds something.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { workbenchHarness } from './helpers/workbench-harness.js'

const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')

describe('Favorites default state', () => {
  it('is decided by the number of visible favourites, not fixed open', () => {
    expect(js).toContain('if (key === FAV_KEY) return !(favs && favs.length)')
    expect(js).not.toMatch(/key === ROOT_KEY \|\| key === FAV_KEY/)
  })
  it('an explicit click still wins over the default', () => {
    const i = js.indexOf('function isShut(key)')
    const body = js.slice(i, i + 400)
    expect(body.indexOf('if (v !== undefined) return !!v')).toBeGreaterThan(-1)
    expect(body.indexOf('if (v !== undefined)')).toBeLessThan(body.indexOf('FAV_KEY'))
  })
})

// The real tree render (web/workbench.js run against the DOM stand-in), not just the source text.
const FAV = '*favorites*'
const item = (id: string, pinned: number | null, status = 'draft') => ({ id, project_id: 'p1', title: id, type: 'note', status, folder: null, source_path: null, pinned_at: pinned, created_at: 1, updated_at: 1 })

async function openProject(items: unknown[]) {
  const h = workbenchHarness({ closedFolders: true })
  h.respond((url) => {
    if (url.includes('/api/workbench/items?')) return { status: 200, body: { items, work_folders: { box: 'Munkadarabok', folders: [], truncated: false } } }
    return { status: 200, body: { todos: [] } }
  })
  h.win.MarvinWorkbench.open('p1', 'Robotok')
  await vi.waitFor(() => expect(h.html()).toContain(`data-wb-folder="${FAV}"`))
  return h
}
const rows = (html: string, id: string) => (html.match(new RegExp(`<li class="wb-item-row[^>]*data-wb-ctx-item="${id}"`, 'g')) || []).length
const favButton = (html: string) => html.match(new RegExp(`<button[^>]*data-wb-folder="\\*favorites\\*"[^>]*>`))![0]

describe('Favorites default state, rendered', () => {
  it('an empty Favorites folder is drawn closed: collapsed arrow, aria-expanded=false, no placeholder row', async () => {
    const h = await openProject([item('a', null)])
    expect(favButton(h.html())).toContain('aria-expanded="false"')
    expect(h.html()).toContain('▸ ⭐')
    expect(h.html()).not.toContain('wb-fav-empty')
  })
  it('a Favorites folder holding a pinned item is drawn open and lists it', async () => {
    const h = await openProject([item('a', null), item('fav1', 5)])
    expect(favButton(h.html())).toContain('aria-expanded="true"')
    expect(h.html()).toContain('▾ ⭐')
    expect(h.html()).toContain('data-wb-item="fav1"')
  })
  it('a click on the empty folder opens it and shows the empty-hint; a second click closes it again', async () => {
    const h = await openProject([item('a', null)])
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': FAV })
    expect(favButton(h.html())).toContain('aria-expanded="true"')
    expect(h.html()).toContain('wb-fav-empty')
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': FAV })
    expect(favButton(h.html())).toContain('aria-expanded="false"')
  })
  it('a click on the filled folder closes it', async () => {
    const h = await openProject([item('fav1', 5)])
    const open = rows(h.html(), 'fav1')
    h.click({ 'data-wb-act': 'folder-fold', 'data-wb-folder': FAV })
    expect(favButton(h.html())).toContain('aria-expanded="false"')
    // The starred item also stays in its own folder (the work items box), so closing Favorites removes exactly one row.
    expect(rows(h.html(), 'fav1')).toBe(open - 1)
  })
})
