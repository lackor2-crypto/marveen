// #530 (Boss TG 2833/2845): the files lying in the work items' folders are listed in the Documents panel,
// read only and counted; "Attachment" is a role of the add chooser and asks which submission it goes to.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const BASE = { docs: [], attachments: [], searching: 0, roles: ['source', 'reference', 'related'], close: { items: [], ready: true }, related: [], places: [], ai_access: 'normal', ai_access_modes: ['normal', 'read_all'] }
const FILES = {
  files: [
    { rel: 'Iroda/Beadvany/beadvany.docx', name: 'beadvany.docx', item_id: 'i1', item: 'Beadvany', sub: '', size: 10, mtime: 1760000000 },
    { rel: 'Iroda/Beadvany/Mellekletek/szerzodes.pdf', name: 'szerzodes.pdf', item_id: 'i1', item: 'Beadvany', sub: 'Mellekletek', size: 20, mtime: 1760000100 },
  ],
  truncated: false,
}

async function open(itemFiles: unknown, items: unknown[] = []) {
  const h = workbenchHarness()
  h.respond((url) => {
    if (url.includes('/api/workbench/project-docs')) return { status: 200, body: { ...BASE, item_files: itemFiles } }
    return { status: 200, body: itemsBody(items) }
  })
  h.win.MarvinWorkbench.open('p1', 'Iroda')
  await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="pd-open"'))
  h.click({ 'data-wb-act': 'pd-open' })
  await vi.waitFor(() => expect(h.html()).toContain('workbench.pd.group.files'))
  return h
}

describe('Munkadarab-mappak fajljai az Iratokban', () => {
  it('lists each file once, read only, with its work item and sub-folder, and counts them', async () => {
    const h = await open(FILES)
    const html = h.html()
    expect(html).toContain('beadvany.docx')
    expect(html).toContain('szerzodes.pdf')
    expect(html).toContain('Mellekletek')
    expect(html).toContain('⟦workbench.pd.file_of:{"item":"Beadvany"}⟧')
    expect(html).toContain('workbench.pd.group.files⟧: 2')
    expect(html).not.toContain('data-wb-pd-remove')
  })

  it('no file yet: says so, count 0', async () => {
    const h = await open({ files: [], truncated: false })
    const html = h.html()
    expect(html).toContain('⟦workbench.pd.files_none⟧')
    expect(html).toContain('workbench.pd.group.files⟧: 0')
  })
})

describe('Melleklet szerep', () => {
  it('the role chooser offers Attachment and then asks which submission', async () => {
    const h = await open(FILES, [{ id: 'i1', title: 'Beadvany', type: 'document', status: 'draft' }])
    expect(h.html()).toContain('⟦workbench.pd.role.attachment⟧')
    expect(h.html()).not.toContain('id="wbPdTarget"')
    h.change('wbPdRole', [], 'attachment')
    await vi.waitFor(() => expect(h.html()).toContain('id="wbPdTarget"'))
    expect(h.html()).toContain('Beadvany')
  })
})

// #539 (Boss TG 2857 "A"): with a work item open the panel lists THAT item's documents; a switch shows the project's.
describe('Iratok: a megnyitott munkadarab iratai, kapcsolo az egesz projektre', () => {
  const ITEMS = [
    { id: 'i1', title: 'Beadvany', type: 'document', status: 'draft' },
    { id: 'i2', title: 'Masik', type: 'document', status: 'draft' },
  ]
  const TWO = {
    files: [
      { rel: 'Iroda/Kozos/a.docx', name: 'a.docx', item_id: 'i1', item_ids: ['i1', 'i2'], item: 'Beadvany', sub: '', size: 1, mtime: 1760000000 },
      { rel: 'Iroda/Masik/b.pdf', name: 'b.pdf', item_id: 'i2', item_ids: ['i2'], item: 'Masik', sub: '', size: 1, mtime: 1760000000 },
    ],
    truncated: false,
  }
  async function openWith(item: string) {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/api/workbench/project-docs')) {
        return { status: 200, body: { ...BASE, docs: [{ id: 'd1', name: 'x.pdf', role: 'source', ai: true, life_rel: 'Iroda/x.pdf' }], item_files: TWO } }
      }
      const m = /\/api\/workbench\/items\/(i\d)/.exec(url)
      if (m) return { status: 200, body: { item: ITEMS.find((i) => i.id === m[1]), versions: [], parts: [], project: { id: 'p1', name: 'Iroda', archived: false } } }
      return { status: 200, body: itemsBody(ITEMS) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="' + item + '"'))
    h.click({ 'data-wb-item': item })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="pd-open"'))
    h.click({ 'data-wb-act': 'pd-open' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.pd.group.files'))
    return h
  }

  it('a file in a folder shared by two items shows up under either of them; the other item\'s file does not', async () => {
    const h = await openWith('i1')
    expect(h.html()).toContain('a.docx')
    expect(h.html()).not.toContain('b.pdf')
    const h2 = await openWith('i2')
    expect(h2.html()).toContain('a.docx')
    expect(h2.html()).toContain('b.pdf')
  })

  it('the AI pill keeps the project\'s real count in the item view (never "0 / 0")', async () => {
    const h = await openWith('i1')
    expect(h.html()).toContain('workbench.pd.ai_count:{"n":1,"total":1}')
  })

  it('the switch shows the whole project', async () => {
    const h = await openWith('i1')
    h.fire('change', { target: { getAttribute: (a: string) => (a === 'data-wb-pd-scope' ? '1' : null), checked: true, closest: () => null }, preventDefault() {} })
    await vi.waitFor(() => expect(h.html()).toContain('b.pdf'))
    expect(h.html()).toContain('a.docx')
  })

  // #539 (Boss TG 8619): in the item view the panel lists only what belongs to the open work item.
  describe('item view lists only the item\'s own places', () => {
    const PLACES = [
      { rel: 'Iroda/Beadvany', exists: true, reachable: true, manual: false, auto: true, count: 1, reasons: [{ kind: 'item', name: 'Beadvany', item_id: 'i1' }], more: 0, item_counts: { i1: 1 } },
      { rel: 'Iroda/Masik', exists: true, reachable: true, manual: false, auto: true, count: 1, reasons: [{ kind: 'item', name: 'Masik', item_id: 'i2' }], more: 0, item_counts: { i2: 1 } },
      { rel: 'Csalad/Irat', exists: true, reachable: true, manual: false, auto: true, count: 1, reasons: [{ kind: 'source', name: 'x.pdf' }], more: 0, item_counts: {} },
      { rel: 'Csalad/Kezi', exists: true, reachable: true, manual: true, auto: false, count: 0, reasons: [], more: 0, item_counts: {} },
    ]
    async function openPlaces() {
      const h = workbenchHarness()
      h.respond((url) => {
        if (url.includes('/api/workbench/project-docs')) {
          return { status: 200, body: { ...BASE, places: PLACES, related: [{ id: 'p9', name: 'Rokon', archived: false }], relatable: [{ id: 'p8', name: 'Masik proj' }], item_files: { files: [], truncated: false } } }
        }
        const m = /\/api\/workbench\/items\/(i\d)/.exec(url)
        if (m) return { status: 200, body: { item: ITEMS.find((i) => i.id === m[1]), versions: [], parts: [], project: { id: 'p1', name: 'Iroda', archived: false } } }
        return { status: 200, body: itemsBody(ITEMS) }
      })
      h.win.MarvinWorkbench.open('p1', 'Iroda')
      await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="i1"'))
      h.click({ 'data-wb-item': 'i1' })
      await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="pd-open"'))
      h.click({ 'data-wb-act': 'pd-open' })
      await vi.waitFor(() => expect(h.html()).toContain('workbench.pd.places_title'))
      return h
    }

    it('shows its own place only; the other item, the document place, the hand-added place, related projects, the close list and the add button are not there', async () => {
      const h = await openPlaces()
      const html = h.html()
      expect(html).toContain('Iroda › Beadvany')
      expect(html).not.toContain('Iroda › Masik')
      expect(html).not.toContain('Csalad › Irat')
      expect(html).not.toContain('Csalad › Kezi')
      expect(html).toContain('workbench.pd.places_title⟧ (1)')
      expect(html).not.toContain('data-wb-act="pd-place-add"')
      expect(html).not.toContain('workbench.pd.related_title')
      expect(html).not.toContain('workbench.pd.close_title')
      expect(html).toContain('workbench.pd.access_project_wide')
    })

    it('the project view still shows everything', async () => {
      const h = await openPlaces()
      h.fire('change', { target: { getAttribute: (a: string) => (a === 'data-wb-pd-scope' ? '1' : null), checked: true, closest: () => null }, preventDefault() {} })
      await vi.waitFor(() => expect(h.html()).toContain('Iroda › Masik'))
      const html = h.html()
      expect(html).toContain('Csalad › Irat')
      expect(html).toContain('Csalad › Kezi')
      expect(html).toContain('data-wb-act="pd-place-add"')
      expect(html).toContain('workbench.pd.related_title')
      expect(html).toContain('workbench.pd.close_title')
      expect(html).not.toContain('workbench.pd.access_project_wide')
    })
  })
})
