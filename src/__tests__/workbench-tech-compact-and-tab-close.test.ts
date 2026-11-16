// #906 follow-up (Boss TG 6255/6257): the Technical details are compact (no long scroll), and with them open a rail tab pressed
// a second time folds the folder column away again (before: shTechWide stayed true, so the column could not be closed).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('technical details: compact layout and closing the column', () => {
  it('closing the rail tab while the details are open collapses the folder column (not wide)', () => {
    const line = js.split('\n').find((l) => l.includes("a === 'fr-tab'")) ?? ''
    expect(line).toContain('WB.shTechWide = !(closing && WB.shMore)')
    expect(line).not.toMatch(/WB\.shTechWide = true;/)
  })
  it('one press of the Projects button closes a column that is open only because the details are (frTab is empty then)', () => {
    const line = js.split('\n').find((l) => l.includes("a === 'fr-tab'")) ?? ''
    expect(line).toContain("(!WB.frTab && !!WB.shMore && tb === 'projects' && !frPanelCollapsed())")
  })
  it('the project/work item context blocks flow into columns inside the details', () => {
    expect(css).toMatch(/\.wb-fr-center-tech \.wb-panel-context \{[^}]*display: block[^}]*column-width/)
  })
  it('the details block is a compact multi-column grid with small tool buttons', () => {
    expect(css).toMatch(/\.wb-fr-center-tech \.wb-sh-tech \{[^}]*display: grid[^}]*repeat\(auto-fit/)
    expect(css).toMatch(/\.wb-fr-center-tech \.wb-sh-tech-actions \.btn-secondary \{[^}]*font-size: 12px/)
  })
})

// #920 (the card was sent back: the details STILL needed scrolling, 1133 px in a 520 px column): the blocks of the details fold by
// their heading, the tools and "this work item" start open and the whole project block starts folded; the choice is remembered.
import { vi } from 'vitest'
import { workbenchHarness, itemsBody, PROJECT } from './helpers/workbench-harness.js'

const ITEM = { id: 'w1', title: 'Ajánlat', type: 'note', status: 'draft', current_version_id: 'v1' }
const VIEW = 'marveen.workbench.view'

async function openDetails(storage: Record<string, string> = {}) {
  const h = workbenchHarness({ storage: { [VIEW]: 'simple', ...storage } })
  h.respond((url) => {
    if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source', message: 'x' } }
    if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: ITEM, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project: PROJECT } }
    return { status: 200, body: itemsBody([ITEM]) }
  })
  h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-root-simple|wb-items/))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.html()).toContain('wb-fr-center'))
  h.click({ 'data-wb-act': 'sh-more' })
  return h
}

describe('#920: the technical details fold by block', () => {
  it('opens with the tools and the work item block open and the project block folded', async () => {
    const h = await openDetails()
    const html = h.html()
    expect(html).toContain('data-wb-act="search-open"')
    expect(html).toContain('data-wb-act="sh-tech-fold" data-wb-arg="project" aria-expanded="false"')
    expect(html).toContain('data-wb-act="sh-tech-fold" data-wb-arg="tools" aria-expanded="true"')
    expect(html).not.toContain('wb-panel-context')
  })
  it('the heading of a folded block opens it, and pressing it again folds it; the choice is remembered', async () => {
    const h = await openDetails()
    h.click({ 'data-wb-act': 'sh-tech-fold', 'data-wb-arg': 'project' })
    expect(h.html()).toContain('wb-panel-context')
    expect(h.storage['wb.sh.tech.shut']).toBe('')
    h.click({ 'data-wb-act': 'sh-tech-fold', 'data-wb-arg': 'tools' })
    expect(h.html()).not.toContain('data-wb-act="search-open"')
    expect(h.storage['wb.sh.tech.shut']).toBe('tools')
    h.click({ 'data-wb-act': 'sh-tech-fold', 'data-wb-arg': 'tools' })
    expect(h.html()).toContain('data-wb-act="search-open"')
  })
  it('a remembered choice is used when the page is opened again', async () => {
    const h = await openDetails({ 'wb.sh.tech.shut': 'tools,item' })
    expect(h.html()).not.toContain('data-wb-act="search-open"')
    expect(h.html()).toContain('wb-panel-context')
  })
  it('the fold hint exists in both languages', () => {
    const hu = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf8')
    const en = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf8')
    for (const k of ['workbench.sh.tech_fold', 'workbench.sh.tech_unfold']) { expect(hu).toContain('"' + k + '"'); expect(en).toContain('"' + k + '"') }
  })
})
