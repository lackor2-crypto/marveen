// Card #469: right-click (or the "..." button on phones) on a loose file -> work item;
// on a folder of pictures -> ONE flippable deck, one slide per picture, in natural order.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody, untranslatedHungarian, eventFor, PROJECT } from './helpers/workbench-harness.js'

const BOX = 'Projektek/X/Munkadarabok'
const FOLDER = BOX + '/diak'
const WF = {
  box: BOX, folders: [FOLDER], truncated: false,
  files: {
    [FOLDER]: ['s10.png', 's2.png', 's1.png', 'jegyzet.txt'].map((n) => ({ rel: FOLDER + '/' + n, name: n, size: 2048 })),
    [BOX]: [{ rel: BOX + '/ajanlat.docx', name: 'ajanlat.docx', size: 4096 }],
  },
}

const isCreate = (c: { url: string; init?: RequestInit }) => c.init?.method === 'POST' && /\/api\/workbench\/items(\?|$)/.test(c.url)
const ITEM = { id: 'w0', title: 'Régi', type: 'note', status: 'draft', current_version_id: 'v0', container_folder: BOX }

async function open() {
  const h = workbenchHarness()
  h.respond((url, init) => {
    if (init?.method === 'POST' && /\/api\/workbench\/items(\?|$)/.test(url)) {
      const b = JSON.parse(String(init.body))
      return { status: 201, body: { ok: true, item: { id: 'n1', title: b.title, type: b.type, status: 'draft' }, versions: [] } }
    }
    if (url.includes('/deck/ops')) return { status: 200, body: { ok: true, deck: { version: 1, size: '16:9', slides: [] }, applied: [], created: false } }
    if (url.includes('/api/workbench/items/n1')) return { status: 200, body: { item: { id: 'n1', title: 'x', type: 'note' }, versions: [], parts: [], project: PROJECT } }
    return { status: 200, body: { ...itemsBody([ITEM]), work_folders: WF } }
  })
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-file-row/))
  return h
}
const ctx = (h: Awaited<ReturnType<typeof open>>, attr: string, val: string) => {
  const e = eventFor({ [attr]: val }) as { target: unknown }
  h.fire('contextmenu', { ...e, clientX: 10, clientY: 10 })
}

describe('loose file -> work item', () => {
  it('right-click on a loose file shows "make it a work item" and it creates a typed item pointing at the file', async () => {
    const h = await open()
    ctx(h, 'data-wb-ctx-file', BOX + '/ajanlat.docx')
    expect(h.html()).toContain('data-wb-act="file-to-item"')
    h.click({ 'data-wb-act': 'file-to-item', 'data-wb-rel': BOX + '/ajanlat.docx' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => isCreate(c))).toBe(true))
    const call = h.fetchCalls.find((c) => isCreate(c))!
    expect(JSON.parse(String(call.init!.body))).toMatchObject({ type: 'document', source_path: BOX + '/ajanlat.docx', folder: BOX, title: 'ajanlat' })
  })
  it('every file row and folder row has the "..." button for phones', async () => {
    const h = await open()
    expect(h.html()).toContain('data-wb-act="file-ctx"')
    expect(h.html()).toContain('data-wb-act="folder-ctx"')
    h.click({ 'data-wb-act': 'file-ctx', 'data-wb-rel': BOX + '/ajanlat.docx' })
    expect(h.html()).toContain('data-wb-act="file-to-item"')
  })
})

describe('folder of pictures -> one deck', () => {
  it('the folder menu offers the deck only when the folder holds pictures, with the count', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'folder-ctx', 'data-wb-folder': FOLDER })
    expect(h.html()).toContain('data-wb-act="folder-to-deck"')
    expect(h.html()).toContain('3')
  })
  it('creates ONE presentation item and one slide per picture in natural order (s1, s2, s10)', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'folder-to-deck', 'data-wb-folder': FOLDER })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/deck/ops'))).toBe(true))
    const creates = h.fetchCalls.filter((c) => isCreate(c))
    expect(creates).toHaveLength(1)
    expect(JSON.parse(String(creates[0]!.init!.body))).toMatchObject({ type: 'presentation', title: 'diak', folder: FOLDER })
    const ops = JSON.parse(String(h.fetchCalls.find((c) => c.url.includes('/deck/ops'))!.init!.body)).ops
    expect(ops.filter((o: { op: string }) => o.op === 'addSlide')).toHaveLength(3)
    const srcs = ops.filter((o: { op: string }) => o.op === 'slide').map((o: { id: string; ops: { object: { src: string } }[] }) => o.id + ':' + o.ops[0]!.object.src)
    expect(srcs).toEqual(['d1:' + FOLDER + '/s1.png', 'd2:' + FOLDER + '/s2.png', 'd3:' + FOLDER + '/s10.png'])
  })
  it('no raw Hungarian on screen with the menus open', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'folder-ctx', 'data-wb-folder': FOLDER })
    expect(untranslatedHungarian(h.html(), ['diak', 'Régi', 'Kovács', 'ajanlat.docx', 'jegyzet.txt', 'Projektek', 'Munkadarabok'])).toBe('')
  })
})
