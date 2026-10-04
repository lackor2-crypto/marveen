// Card #483: the loose file's menu also offers Rename and Delete; Delete only runs after the user confirms.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody, eventFor, PROJECT } from './helpers/workbench-harness.js'

const BOX = 'Projektek/X/Munkadarabok'
const FOLDER = BOX + '/diak'
const WF = {
  box: BOX, folders: [FOLDER], truncated: false,
  files: {
    [FOLDER]: ['s10.png', 's2.png', 's1.png', 'jegyzet.txt'].map((n) => ({ rel: FOLDER + '/' + n, name: n, size: 2048 })),
    [BOX]: [{ rel: BOX + '/ajanlat.docx', name: 'ajanlat.docx', size: 4096 }],
  },
}

const ITEM = { id: 'w0', title: 'Régi', type: 'note', status: 'draft', current_version_id: 'v0', container_folder: BOX }

async function open(confirm = true) {
  const h = workbenchHarness({ confirm })
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


const isDelete = (c: { url: string; init?: RequestInit }) => c.init?.method === 'POST' && /\/api\/workbench\/files-delete/.test(c.url)

describe('loose file menu: rename + delete', () => {
  it('the menu (right-click and "...") offers rename and delete, in both languages via t()', async () => {
    const h = await open()
    ctx(h, 'data-wb-ctx-file', BOX + '/ajanlat.docx')
    expect(h.html()).toContain('data-wb-act="file-rename"')
    expect(h.html()).toContain('data-wb-act="file-delete"')
    expect(h.html()).toContain('workbench.file.delete')
  })

  it('the menu also opens and downloads the file itself, as real links to the file', async () => {
    const h = await open()
    ctx(h, 'data-wb-ctx-file', BOX + '/ajanlat.docx')
    const menu = h.html().slice(h.html().indexOf('wb-ctx-menu'))
    const href = '/api/life/file?rel=' + encodeURIComponent(BOX + '/ajanlat.docx')
    expect(menu).toMatch(new RegExp('data-wb-file-open="1" href="' + href.replace(/[?.*+^$()[\]{}|\\]/g, '\\$&') + '" target="_blank"'))
    expect(menu).toContain('href="' + href + '&download=1" download="ajanlat.docx"')
    expect(menu).toContain('workbench.file.open_menu')
    expect(menu).toContain('workbench.file.download')
  })

  it('with several files ticked the menu acts on the selection: no single-file Open / Download / Rename', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'file-sel', 'data-wb-rel': FOLDER + '/s1.png' })
    h.click({ 'data-wb-act': 'file-sel', 'data-wb-rel': FOLDER + '/s2.png' })
    ctx(h, 'data-wb-ctx-file', FOLDER + '/s1.png')
    expect(h.html()).toContain('workbench.file.delete_many')
    expect(h.html()).not.toContain('data-wb-file-open')
    expect(h.html()).not.toContain('data-wb-file-download')
    expect(h.html()).not.toContain('data-wb-act="file-rename"')
  })

  it('delete asks first: a "no" sends nothing', async () => {
    const h = await open(false)
    ctx(h, 'data-wb-ctx-file', BOX + '/ajanlat.docx')
    h.click({ 'data-wb-act': 'file-delete', 'data-wb-rel': BOX + '/ajanlat.docx' })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.fetchCalls.some((c) => isDelete(c))).toBe(false)
  })

  it('delete after a "yes" posts the file to files-delete', async () => {
    const h = await open(true)
    ctx(h, 'data-wb-ctx-file', BOX + '/ajanlat.docx')
    h.click({ 'data-wb-act': 'file-delete', 'data-wb-rel': BOX + '/ajanlat.docx' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => isDelete(c))).toBe(true))
    expect(JSON.parse(String(h.fetchCalls.find((c) => isDelete(c))!.init!.body))).toMatchObject({ project_id: 'p1', rels: [BOX + '/ajanlat.docx'] })
  })
})
