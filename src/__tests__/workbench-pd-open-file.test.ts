// #542 (owner, 2026-10-10): in the Documents panel "open" and "original place" did nothing useful. "Open" was a plain
// link to the raw file (a download in a new tab), not wired to "open it in the machine's own program" (#529) like the
// file list; the attachments list had no "open" at all; and "original place" changed the address bar and then stayed
// silent when the Explorer was not there. The panel is run here for real (workbench harness), every list of it.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const BASE = { docs: [], attachments: [], searching: 0, roles: ['source', 'reference', 'related'], close: { items: [], ready: true }, related: [], places: [], ai_access: 'normal', ai_access_modes: ['normal', 'read_all'] }
const DATA = {
  ...BASE,
  docs: [
    { id: 'd1', name: 'linked.docx', role: 'source', ai: true, life_rel: 'Iroda/linked.docx', exists: true },
    { id: 'd2', name: 'official.pdf', role: 'official', ai: true, life_rel: 'Iroda/official.pdf', exists: true },
    { id: 'd3', name: 'gone.docx', role: 'source', ai: true, life_rel: 'Iroda/gone.docx', exists: false },
  ],
  attachments: [
    { item_id: 'i1', item: 'Beadvany', label: '1. melleklet', title: 'Szerzodes', name: 'szerzodes.xlsx', life_rel: 'Iroda/Beadvany/szerzodes.xlsx', exists: true },
    { item_id: 'i1', item: 'Beadvany', label: '2. melleklet', title: 'Hianyzo', name: 'hianyzo.pdf', life_rel: 'Iroda/Beadvany/hianyzo.pdf', exists: false },
  ],
  item_files: {
    files: [{ rel: 'Iroda/Beadvany/Mellekletek/uj dokumentum.docx', name: 'uj dokumentum.docx', item_id: 'i1', item_ids: ['i1'], item: 'Beadvany', sub: 'Mellekletek', size: 1, mtime: 1760000000 }],
    truncated: false,
  },
}

async function openPanel() {
  const h = workbenchHarness()
  h.respond((url) => {
    if (url.includes('/api/workbench/project-docs')) return { status: 200, body: DATA }
    return { status: 200, body: itemsBody([]) }
  })
  h.win.MarvinWorkbench.open('p1', 'Iroda')
  await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="pd-open"'))
  h.click({ 'data-wb-act': 'pd-open' })
  await vi.waitFor(() => expect(h.html()).toContain('workbench.pd.group.files'))
  return h
}

/** The "open" links of the panel: the path each one carries for the open-on-machine handler. */
function openLinks(html: string): string[] {
  return [...html.matchAll(/<a class="wb-linklike" data-wb-open-rel="([^"]*)" href="\/api\/life\/file\?rel=[^"]*"[^>]*>⟦workbench\.pd\.open_file⟧<\/a>/g)].map((m) => m[1]!)
}

describe('Documents panel: "open" is the same in every list (#542)', () => {
  it('linked, official, attached and folder files each carry the marker the open-on-machine handler reads', async () => {
    const h = await openPanel()
    const links = openLinks(h.html())
    expect(links.sort()).toEqual([
      'Iroda/Beadvany/Mellekletek/uj dokumentum.docx',
      'Iroda/Beadvany/szerzodes.xlsx',
      'Iroda/linked.docx',
      'Iroda/official.pdf',
    ].sort())
  })

  it('a document that is not on the disk has no open link, only the reason and the original place', async () => {
    const h = await openPanel()
    const html = h.html()
    expect(openLinks(html)).not.toContain('Iroda/gone.docx')
    expect(openLinks(html)).not.toContain('Iroda/Beadvany/hianyzo.pdf')
    expect(html).toContain('workbench.annex.linked_missing')
    expect(html).toContain('data-wb-rel="Iroda/Beadvany/hianyzo.pdf"')
  })

  it('the handler that reads the marker is there, and falls back to the link with the reason', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(src).toContain("var a = e.target.closest('a[data-wb-open-rel]')")
    expect(src).toContain("window.showToast(r.message || t('intezo.open_local_failed'))")
    expect(src).toContain("a.setAttribute('data-wb-no-local', '1')") // re-click: the authenticated fetch path, not a bare window.open
  })
})

describe('Documents panel: "original place" shows the folder, or says why not (#542)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('opens the Explorer at the folder the file lies in', async () => {
    const loc = { hash: '' }
    vi.stubGlobal('location', loc)
    const h = await openPanel()
    const open = vi.fn()
    h.win._intezoOpen = open
    h.click({ 'data-wb-act': 'outline-annex-origin', 'data-wb-rel': 'Iroda/Beadvany/Mellekletek/uj dokumentum.docx' })
    expect(loc.hash).toBe('#intezo')
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('Iroda/Beadvany/Mellekletek'))
    expect(h.toasts).toEqual([])
  })

  it('a file directly in the project root opens the Explorer root', async () => {
    vi.stubGlobal('location', { hash: '' })
    const h = await openPanel()
    const open = vi.fn()
    h.win._intezoOpen = open
    h.click({ 'data-wb-act': 'outline-annex-origin', 'data-wb-rel': 'rootfile.docx' })
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(''))
  })

  it('when the Explorer is not there it says so instead of staying silent', async () => {
    vi.stubGlobal('location', { hash: '' })
    const h = await openPanel()
    delete h.win._intezoOpen
    h.click({ 'data-wb-act': 'outline-annex-origin', 'data-wb-rel': 'Iroda/Beadvany/szerzodes.xlsx' })
    await vi.waitFor(() => expect(h.toasts).toEqual(['⟦workbench.annex.origin_unavailable⟧']))
  })
})
