// #492 (Boss TG 7948): in the Workbench list a work item's own file is never moved away, only copied (the owner
// is told why), a loose file still moves, and a folder another work item uses asks once more before the Kuka.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workbenchHarness, itemsBody, eventFor, PROJECT } from './helpers/workbench-harness.js'

const BOX = 'Munkadarabok'
const ITEM_DIR = BOX + '/Kampany/Poszt'
const TARGET = BOX + '/Cel'
const LIFE = 'Projektek/X/'
const ITEM_FILE = LIFE + ITEM_DIR + '/kep.png'
const LOOSE = LIFE + BOX + '/Kampany/laza.txt'
const WF = {
  box: BOX, folders: [BOX + '/Kampany', ITEM_DIR, TARGET], truncated: false,
  files: {
    [ITEM_DIR]: [{ rel: ITEM_FILE, name: 'kep.png', size: 2048, item: true }],
    [BOX + '/Kampany']: [{ rel: LOOSE, name: 'laza.txt', size: 1024 }],
  },
}
const ITEM = { id: 'w0', title: 'Poszt', type: 'note', status: 'draft', current_version_id: 'v0', container_folder: BOX + '/Kampany', folder: ITEM_DIR }

async function open(confirm: boolean | ((m: string) => boolean) = true) {
  const h = workbenchHarness()
  const asked: string[] = []
  h.win.confirm = (m: string) => { asked.push(m); return typeof confirm === 'function' ? confirm(m) : confirm }
  h.respond((url, init) => {
    if (init?.method === 'POST' && url.includes('/api/workbench/files-copy')) return { status: 200, body: { ok: true, copied: ['kep.png'], skipped: [], work_folders: WF } }
    if (init?.method === 'POST' && url.includes('/api/workbench/files-move')) return { status: 200, body: { ok: true, moved: ['laza.txt'], skipped: [], work_folders: WF } }
    return { status: 200, body: { ...itemsBody([ITEM]), work_folders: WF } }
  })
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-file-row/))
  return { h, asked }
}
type H = Awaited<ReturnType<typeof open>>['h']
const ctx = (h: H, rel: string) => {
  const e = eventFor({ 'data-wb-ctx-file': rel }) as { target: unknown }
  h.fire('contextmenu', { ...e, clientX: 10, clientY: 10 })
}
/** The menu's folder list changed: the real `change` listener, with the select's own attribute. */
const pick = (h: H, attr: string, which: string, value: string) => {
  const target = { value, closest: () => null, getAttribute: (a: string) => (a === attr ? which : null) }
  h.fire('change', { target, preventDefault() {} })
}
const calls = (h: H, kind: 'copy' | 'move') => h.fetchCalls.filter((c) => c.init?.method === 'POST' && c.url.includes('/api/workbench/files-' + kind))

describe('#492 a work item file in the Workbench list: copy only', () => {
  it('the file menu has ONE folder list (Boss TG 2514): copy for a work item file, move for any other', async () => {
    const { h } = await open()
    ctx(h, ITEM_FILE)
    let menu = h.html().slice(h.html().indexOf('wb-ctx-menu'))
    expect(menu).toContain('data-wb-copy-files="' + ITEM_FILE + '"')
    expect(menu).not.toContain('data-wb-move-files="' + ITEM_FILE + '"')
    expect(menu).toContain('workbench.files.copy_label')
    ctx(h, LOOSE)
    menu = h.html().slice(h.html().indexOf('wb-ctx-menu'))
    expect(menu).toContain('data-wb-move-files="' + LOOSE + '"')
    expect(menu).not.toContain('data-wb-copy-files="' + LOOSE + '"')
  })

  it('"Move" on it tells the owner it can only be copied; OK copies it, nothing is moved', async () => {
    const { h, asked } = await open(true)
    ctx(h, ITEM_FILE)
    pick(h, 'data-wb-move-files', ITEM_FILE, TARGET)
    await vi.waitFor(() => expect(calls(h, 'copy').length).toBe(1))
    expect(asked[0]).toContain('workbench.file.copy_only')
    expect(asked[0]).toContain('workbench.file.copy_only_ask')
    expect(JSON.parse(String(calls(h, 'copy')[0]!.init!.body))).toEqual({ project_id: 'p1', rels: [ITEM_FILE], folder: TARGET })
    expect(calls(h, 'move')).toEqual([])
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.files.copied'))
  })

  it('Cancel on that question sends nothing', async () => {
    const { h } = await open(false)
    ctx(h, ITEM_FILE)
    pick(h, 'data-wb-move-files', ITEM_FILE, TARGET)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls(h, 'copy')).toEqual([])
    expect(calls(h, 'move')).toEqual([])
  })

  it('a loose file still moves without any question', async () => {
    const { h, asked } = await open(true)
    ctx(h, LOOSE)
    pick(h, 'data-wb-move-files', LOOSE, TARGET)
    await vi.waitFor(() => expect(calls(h, 'move').length).toBe(1))
    expect(asked).toEqual([])
    expect(calls(h, 'copy')).toEqual([])
  })

  it('ticked together: the item\'s file is copied, the loose one moved, after one question', async () => {
    const { h, asked } = await open(true)
    h.click({ 'data-wb-act': 'file-sel', 'data-wb-rel': ITEM_FILE })
    h.click({ 'data-wb-act': 'file-sel', 'data-wb-rel': LOOSE })
    ctx(h, LOOSE)
    pick(h, 'data-wb-move-files', '*', TARGET)
    await vi.waitFor(() => expect(calls(h, 'move').length).toBe(1))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('workbench.file.copy_only_rest')
    expect(JSON.parse(String(calls(h, 'copy')[0]!.init!.body)).rels).toEqual([ITEM_FILE])
    expect(JSON.parse(String(calls(h, 'move')[0]!.init!.body)).rels).toEqual([LOOSE])
  })

  it('"Copy to folder..." copies without a question (any file)', async () => {
    const { h, asked } = await open(true)
    ctx(h, LOOSE)
    pick(h, 'data-wb-copy-files', LOOSE, TARGET)
    await vi.waitFor(() => expect(calls(h, 'copy').length).toBe(1))
    expect(asked).toEqual([])
    expect(calls(h, 'move')).toEqual([])
  })

  // #537: a row draggable onto the PAGE only (shared Kozos anyagok, assets) carries no context-menu marker; dropping
  // it on a folder row must neither move nor copy it.
  it('a page-only row (shared folder) dropped on a folder row does nothing', async () => {
    const { h } = await open(true)
    const row = { getAttribute: (a: string) => (a === 'data-wb-drag-file' ? 'Projektek/Iroda/Közös anyagok/logo.png' : null) }
    const dt = { setData() {}, effectAllowed: '', dropEffect: '' }
    h.fire('dragstart', { target: { closest: (s: string) => (s === '[data-wb-drag-file]' ? row : null) }, dataTransfer: dt })
    const zone = { getAttribute: (a: string) => (a === 'data-wb-drop-folder' ? TARGET : null) }
    h.fire('drop', { target: { closest: (s: string) => (s === '[data-wb-drop-folder]' ? zone : null) }, dataTransfer: dt, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 20))
    expect(calls(h, 'move')).toEqual([])
    expect(calls(h, 'copy')).toEqual([])
  })

  it('dragging the item\'s file onto a folder row asks and copies it', async () => {
    const { h, asked } = await open(true)
    const row = { getAttribute: (a: string) => (a === 'data-wb-drag-file' || a === 'data-wb-ctx-file' ? ITEM_FILE : null) }
    const dt = { setData() {}, effectAllowed: '', dropEffect: '' }
    h.fire('dragstart', { target: { closest: (s: string) => (s === '[data-wb-drag-file]' ? row : null) }, dataTransfer: dt })
    const zone = { getAttribute: (a: string) => (a === 'data-wb-drop-folder' ? TARGET : null) }
    h.fire('drop', { target: { closest: (s: string) => (s === '[data-wb-drop-folder]' ? zone : null) }, dataTransfer: dt, preventDefault() {} })
    await vi.waitFor(() => expect(calls(h, 'copy').length).toBe(1))
    expect(asked[0]).toContain('workbench.file.copy_only')
    expect(calls(h, 'move')).toEqual([])
  })
})

describe('#492 deleting a folder another work item uses', () => {
  it('the server\'s sentence is shown in a second question; yes sends force, the folder goes to the Kuka', async () => {
    const h = workbenchHarness()
    const asked: string[] = []
    h.win.confirm = (m: string) => { asked.push(m); return true }
    let n = 0
    h.respond((url, init) => {
      if (init?.method === 'DELETE' && url.includes('/api/workbench/folders')) {
        n++
        const b = JSON.parse(String(init.body))
        if (!b.force) return { status: 409, body: { error: 'folder_used_elsewhere', message: 'Egy másik munkadarab is használja.', users: ['Prezi'] } }
        return { status: 200, body: { ok: true, trashed: { items: 1, kuka: 'Kuka' }, work_folders: WF, items: [] } }
      }
      return { status: 200, body: { ...itemsBody([ITEM]), work_folders: WF } }
    })
    h.win.MarvinWorkbench.open('p1', PROJECT.name)
    await vi.waitFor(() => expect(h.html()).toMatch(/wb-folder-row/))
    h.click({ 'data-wb-act': 'folder-delete', 'data-wb-folder': BOX + '/Kampany' })
    await vi.waitFor(() => expect(n).toBe(2))
    expect(asked).toHaveLength(2)
    expect(asked[0]).toContain('workbench.folder.delete_confirm')
    expect(asked[1]).toContain('Egy másik munkadarab is használja.')
    expect(asked[1]).toContain('workbench.folder.used_elsewhere_ask')
    const dels = h.fetchCalls.filter((c) => c.init?.method === 'DELETE').map((c) => JSON.parse(String(c.init!.body)))
    expect(dels.map((d) => d.force)).toEqual([false, true])
    expect(dels.every((d) => d.trash === true)).toBe(true)
  })
})

// The card's acceptance (Boss TG 7948): every row of the tree has a Delete in its right-click menu (behind the "..."
// button on a phone too); the folder one warns first (both languages, naming the Kuka), and Cancel sends nothing.
describe('#492 right-click Delete on every row', () => {
  const menu = (h: H) => { const s = h.html(); const i = s.indexOf('wb-ctx-menu'); return i < 0 ? '' : s.slice(i) }
  const FOLDER = BOX + '/Kampany'

  it('folder, work item and plain file rows each offer Delete in their right-click menu', async () => {
    const { h } = await open()
    expect(menu(h)).toBe('')
    h.fire('contextmenu', { ...eventFor({ 'data-wb-ctx-folder': FOLDER }), clientX: 10, clientY: 10 })
    expect(menu(h)).toContain('data-wb-act="folder-delete" data-wb-folder="' + FOLDER + '"')
    h.fire('contextmenu', { ...eventFor({ 'data-wb-ctx-item': ITEM.id }), clientX: 10, clientY: 10 })
    expect(menu(h)).toContain('data-wb-act="item-trash" data-wb-id="' + ITEM.id + '"')
    ctx(h, LOOSE)
    expect(menu(h)).toContain('data-wb-act="file-delete" data-wb-rel="' + LOOSE + '"')
  })

  it('on a phone (no right-click) the folder row\'s "..." button opens the same menu with Delete', async () => {
    const { h } = await open()
    expect(h.html()).toContain('data-wb-act="folder-ctx" data-wb-folder="' + FOLDER + '"')
    h.click({ 'data-wb-act': 'folder-ctx', 'data-wb-folder': FOLDER })
    expect(menu(h)).toContain('data-wb-act="folder-delete" data-wb-folder="' + FOLDER + '"')
  })

  it('folder Delete warns first; Cancel sends nothing', async () => {
    const { h, asked } = await open(false)
    h.click({ 'data-wb-act': 'folder-delete', 'data-wb-folder': FOLDER })
    await new Promise((r) => setTimeout(r, 20))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('workbench.folder.delete_confirm')
    expect(h.fetchCalls.filter((c) => c.init?.method === 'DELETE')).toEqual([])
  })

  it('the folder warning says the content is lost but restorable from the Kuka, in both languages', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const text = (lang: string, key: string): string => {
      const src = readFileSync(join(root, 'web', 'lang', lang + '.js'), 'utf8')
      const m = src.match(new RegExp('"' + key.replace(/\./g, '\\.') + '":\\s*"((?:[^"\\\\]|\\\\.)*)"'))
      return m ? m[1]! : ''
    }
    const hu = text('hu', 'workbench.folder.delete_confirm')
    const en = text('en', 'workbench.folder.delete_confirm')
    expect(hu).toMatch(/Ha törlöd/)
    expect(hu).toMatch(/elveszíted/)
    expect(hu).toMatch(/Kukából vissza tudod állítani/)
    expect(en).toMatch(/If you delete the folder/)
    expect(en).toMatch(/you lose everything in it/)
    expect(en).toMatch(/restore it from the Trash/)
  })

  // Boss ("B"): the work item Delete asks once too; a yes sends it to the Workbench trash, a no sends nothing.
  it('work item Delete asks first by name; Cancel sends nothing, yes moves it to the Workbench trash', async () => {
    const { h, asked } = await open(false)
    h.click({ 'data-wb-act': 'item-trash', 'data-wb-id': ITEM.id })
    await new Promise((r) => setTimeout(r, 20))
    expect(asked).toEqual(['⟦workbench.trash.delete_confirm:{"name":"Poszt"}⟧'])
    expect(h.fetchCalls.filter((c) => c.url.includes('/trash'))).toEqual([])
    h.win.confirm = () => true
    h.click({ 'data-wb-act': 'item-trash', 'data-wb-id': ITEM.id })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/' + ITEM.id + '/trash'))).toBe(true))
  })
})
