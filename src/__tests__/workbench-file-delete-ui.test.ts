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
    // Still a real link to the file; #529 adds which file it is, so an office document can
    // open in the machine's own program when the browser is on the machine.
    expect(menu).toMatch(new RegExp('data-wb-file-open="1" data-wb-open-rel="[^"]*ajanlat\\.docx" href="' + href.replace(/[?.*+^$()[\]{}|\\]/g, '\\$&') + '" target="_blank"'))
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

  it('Shift+click ticks every file between the last clicked one and this one; Shift again on a ticked one unticks the range', async () => {
    const h = await open()
    const rel = (n: string) => FOLDER + '/' + n
    const shiftClick = (n: string) => h.fire('click', { ...(eventFor({ 'data-wb-act': 'file-sel', 'data-wb-rel': rel(n) }) as object), shiftKey: true })
    const ticked = () => (h.html().match(/class="wb-file-sel"[^>]*data-wb-rel="([^"]*)"[^>]* checked/g) || []).length
    h.click({ 'data-wb-act': 'file-sel', 'data-wb-rel': rel('s10.png') })
    expect(ticked()).toBe(1)
    shiftClick('s1.png')
    expect(ticked()).toBe(3)
    shiftClick('s2.png')
    expect(ticked()).toBe(1)
    h.click({ 'data-wb-act': 'sel-clear' })
    expect(ticked()).toBe(0)
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

// #529 (Boss TG 8582, 8585): delete from the selection bar, one always-visible trash, Undo after a delete.
const isRestore = (c: { url: string; init?: RequestInit }) => c.init?.method === 'POST' && /\/api\/workbench\/file-trash\/restore/.test(c.url)
const DOC_ITEM = { id: 'd1', title: 'Új dokumentum', type: 'document', status: 'draft', current_version_id: 'v1', container_folder: BOX, source_path: BOX + '/ajanlat.docx' }

async function openTrash(opts: { confirm?: boolean; fileTrash?: unknown[] } = {}) {
  const h = workbenchHarness({ confirm: opts.confirm !== false })
  h.respond((url, init) => {
    if (/\/api\/workbench\/file-trash\/restore/.test(url)) {
      return { status: 200, body: { ok: true, restored: [{ name: 'ajanlat.docx', rel: BOX + '/ajanlat.docx', renamed: false }], failed: [], file_trash: [], work_folders: WF } }
    }
    if (/\/api\/workbench\/file-trash/.test(url)) return { status: 200, body: { ok: true, files: opts.fileTrash || [], kuka_rel: 'Kuka' } }
    if (/\/api\/workbench\/files-delete/.test(url)) {
      return { status: 200, body: { ok: true, deleted: ['ajanlat.docx'], skipped: [], trash: ['t1'], file_trash: [{ id: 't1', name: 'ajanlat.docx', orig_rel: BOX + '/ajanlat.docx', folder: BOX, deleted_at: 1 }], work_folders: WF } }
    }
    return { status: 200, body: { ...itemsBody([ITEM, DOC_ITEM]), work_folders: WF } }
  })
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-file-row/))
  return h
}

describe('#529 selection bar delete + one trash', () => {
  it('the bar has a delete button next to a "deselect" one; a "no" sends nothing', async () => {
    const h = await openTrash({ confirm: false })
    h.click({ 'data-wb-act': 'file-sel', 'data-wb-rel': FOLDER + '/jegyzet.txt' })
    const bar = h.html().slice(h.html().indexOf('wb-sel-bar'))
    expect(bar).toMatch(/data-wb-act="file-delete" data-wb-rel="\*"/)
    expect(bar).toContain('workbench.sel.delete')
    expect(bar).toContain('workbench.sel.clear')
    h.click({ 'data-wb-act': 'file-delete', 'data-wb-rel': '*' })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.confirms).toHaveLength(1)
    expect(h.fetchCalls.some((c) => isDelete(c))).toBe(false)
  })

  it('the question names the work item a file belongs to; a "yes" deletes every ticked file and the toast carries Undo', async () => {
    const h = await openTrash()
    h.click({ 'data-wb-act': 'file-sel', 'data-wb-rel': BOX + '/ajanlat.docx' })
    h.click({ 'data-wb-act': 'file-sel', 'data-wb-rel': FOLDER + '/jegyzet.txt' })
    h.click({ 'data-wb-act': 'file-delete', 'data-wb-rel': '*' })
    expect(h.confirms[0]).toContain('workbench.file.delete_confirm_many')
    expect(h.confirms[0]).toContain('workbench.file.delete_item_note')
    expect(h.confirms[0]).toContain('Új dokumentum')
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => isDelete(c))).toBe(true))
    expect(JSON.parse(String(h.fetchCalls.find((c) => isDelete(c))!.init!.body)).rels.sort()).toEqual([BOX + '/ajanlat.docx', FOLDER + '/jegyzet.txt'].sort())
    await vi.waitFor(() => expect(h.toastActions).toHaveLength(1))
    // The trash opens by itself and shows the deleted file with Restore.
    expect(h.html()).toContain('data-wb-act="file-restore" data-wb-id="t1"')
    h.toastActions[0]!.onClick()
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => isRestore(c))).toBe(true))
    expect(JSON.parse(String(h.fetchCalls.find((c) => isRestore(c))!.init!.body))).toEqual({ project_id: 'p1', ids: ['t1'] })
  })

  it('the trash is there when empty too, and says it is empty', async () => {
    const h = await openTrash()
    expect(h.html()).toContain('data-wb-act="trash-toggle"')
    expect(h.html()).toContain('workbench.trash.empty_short')
    h.click({ 'data-wb-act': 'trash-toggle' })
    expect(h.html()).toContain('workbench.trash.empty')
    expect(h.html()).toContain('data-wb-act="kuka-open"')
  })

  it('a file deleted earlier is listed in the trash and Restore posts its id', async () => {
    const h = await openTrash({ fileTrash: [{ id: 'old1', name: 'Régi.docx', orig_rel: BOX + '/Régi.docx', folder: BOX, deleted_at: 1 }] })
    await vi.waitFor(() => expect(h.html()).toContain('(1)'))
    h.click({ 'data-wb-act': 'trash-toggle' })
    expect(h.html()).toContain('Régi.docx')
    h.click({ 'data-wb-act': 'file-restore', 'data-wb-id': 'old1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => isRestore(c))).toBe(true))
    expect(JSON.parse(String(h.fetchCalls.find((c) => isRestore(c))!.init!.body))).toEqual({ project_id: 'p1', ids: ['old1'] })
  })
})
