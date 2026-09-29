// #443 (Boss, 2026-09-29): "Levetel / Torles" -- csak levetel, vagy vegleges
// torles a mappabol is ("szemetet nem kellene hagyni a rendszerben"); egy
// gombnyomasos mappa-megnyitas az Anyagok, a Kozos tar, a Verziok fejleceben es
// minden anyag-soron ("C" + "2A": Intezo ES a gep fajlkezeloje); az
// "olvashato"/"felhasznalhato" cimke eltunik.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { attachAsset, uploadSharedFile, linkSharedAsset, workbenchPlace, listWorkItemAssets } from '../workbench-assets.js'
import { explorerScript } from '../open-in-file-manager.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

describe('levetel / torles es mappa-megnyitas (szerver)', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-asset-del-'))
    mkdirSync(projDir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    const up = updateProject(pid, { folder_path: 'Projektek/Iroda' })
    if (!up.ok) throw new Error('projektmappa')
    project = getProject(pid) as ProjectRow
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function newItem(title = 'Ajanlat') {
    const w = createWorkItem({ project_id: pid, title, type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    return w.item
  }

  it('`?file=1`: a fajl a mappabol is torlodik, es az anyag-sor sem marad', async () => {
    const item = newItem()
    const r = attachAsset(item, 'jegyzet.md', Buffer.from('X'))
    if (!r.ok) throw new Error('anyag')
    const file = join(projDir(), 'Ajanlat', 'jegyzet.md')
    expect(existsSync(file)).toBe(true)
    const del = await callWorkbench(`/api/workbench/items/${item.id}/assets/${r.asset.id}?file=1`, 'DELETE')
    expect(del.status).toBe(200)
    expect(del.body.deleted).toBe(true)
    expect(del.body.assets).toEqual([])
    expect(existsSync(file)).toBe(false)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM work_item_assets WHERE id = ?').get(r.asset.id)).toEqual({ n: 0 })
  })

  it('`file` nelkul csak levetel: a fajl a mappaban marad', async () => {
    const item = newItem()
    const r = attachAsset(item, 'jegyzet.md', Buffer.from('X'))
    if (!r.ok) throw new Error('anyag')
    const del = await callWorkbench(`/api/workbench/items/${item.id}/assets/${r.asset.id}`, 'DELETE')
    expect(del.status).toBe(200)
    expect(existsSync(join(projDir(), 'Ajanlat', 'jegyzet.md'))).toBe(true)
  })

  it('ha a fajlt masik munkadarab is hasznalja, NEM torli, es megmondja, ki hasznalja', async () => {
    const sh = uploadSharedFile(project, 'logo.png', Buffer.from('PNG'))
    if (!sh.ok) throw new Error('kozos tar')
    const a = newItem('Ajanlat')
    const b = newItem('Szorolap')
    const la = linkSharedAsset(a, sh.file.path)
    const lb = linkSharedAsset(b, sh.file.path)
    if (!la.ok || !lb.ok) throw new Error('hivatkozas')
    const del = await callWorkbench(`/api/workbench/items/${a.id}/assets/${la.asset.id}?file=1`, 'DELETE')
    expect(del.status).toBe(409)
    expect(del.body.error).toBe('asset_in_use')
    expect(del.body.users).toEqual(['Szorolap'])
    expect(del.body.message).toContain('Szorolap')
    expect(existsSync(join(depot, sh.file.path))).toBe(true)
    expect(listWorkItemAssets(a.id)).toHaveLength(1)
  })

  it('a munkadarab fo fajlja sem torolheto innen', async () => {
    const item = newItem()
    const r = attachAsset(item, 'terv.md', Buffer.from('T'))
    if (!r.ok) throw new Error('anyag')
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(r.asset.path, item.id)
    const del = await callWorkbench(`/api/workbench/items/${item.id}/assets/${r.asset.id}?file=1`, 'DELETE')
    expect(del.status).toBe(409)
    expect(existsSync(join(projDir(), 'Ajanlat', 'terv.md'))).toBe(true)
  })

  it('a helyek: Anyagok = a munkadarab mappaja, Kozos tar, Verziok = a fo fajl mappaja, anyag = a fajl kijelolve', () => {
    const item = newItem()
    const r = attachAsset(item, 'jegyzet.md', Buffer.from('X'))
    if (!r.ok) throw new Error('anyag')
    const fresh = getWorkItem(item.id)!
    const assets = workbenchPlace(project, fresh, 'assets')
    expect(assets.ok && assets.dirRel).toBe('Projektek/Iroda/Ajanlat')
    const one = workbenchPlace(project, fresh, 'asset', r.asset.id)
    expect(one.ok && one.dirRel).toBe('Projektek/Iroda/Ajanlat')
    expect(one.ok && one.select).toBe('jegyzet.md')
    expect(workbenchPlace(project, null, 'shared')).toMatchObject({ ok: false, code: 'no_shared_folder' })
    const sh = uploadSharedFile(project, 'logo.png', Buffer.from('PNG'))
    if (!sh.ok) throw new Error('kozos tar')
    const shared = workbenchPlace(project, null, 'shared')
    expect(shared.ok && shared.dirRel.startsWith('Projektek/Iroda/')).toBe(true)
    mkdirSync(join(projDir(), 'Forras'))
    writeFileSync(join(projDir(), 'Forras', 'fo.md'), 'F')
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run('Projektek/Iroda/Forras/fo.md', item.id)
    const versions = workbenchPlace(project, getWorkItem(item.id)!, 'versions')
    expect(versions.ok && versions.dirRel).toBe('Projektek/Iroda/Forras')
    expect(workbenchPlace(project, fresh, 'barhol')).toMatchObject({ ok: false, code: 'bad_place' })
  })

  it('a projekt mappajan kivuli ut nem nyilik meg', () => {
    const item = newItem()
    mkdirSync(join(depot, 'Masik'))
    writeFileSync(join(depot, 'Masik', 'titok.md'), 'T')
    getDb().prepare('UPDATE work_items SET source_path = ?, folder = NULL WHERE id = ?').run('Masik/titok.md', item.id)
    expect(workbenchPlace(project, getWorkItem(item.id)!, 'versions')).toMatchObject({ ok: false, code: 'no_item_folder' })
  })

  it('POST /open-folder (Intezo): a mappa utja + a projekt; mappa nelkul emberi uzenet', async () => {
    const item = newItem()
    const none = await callWorkbench('/api/workbench/open-folder', 'POST', { project: pid, item: item.id, place: 'assets', app: 'intezo' })
    expect(none.status).toBe(404)
    expect(none.body.error).toBe('no_item_folder')
    expect(none.body.message).toMatch(/mappája/)
    attachAsset(item, 'a.md', Buffer.from('A'))
    const ok = await callWorkbench('/api/workbench/open-folder', 'POST', { project: pid, item: item.id, place: 'assets', app: 'intezo' })
    expect(ok.status).toBe(200)
    expect(ok.body.path).toBe('Projektek/Iroda/Ajanlat')
    expect(ok.body.project).toEqual({ id: pid, name: 'Iroda fejlesztese' })
  })

  it('a Windows-parancs a szokozos, aposztrofos utat is egyben adja at, fajlnal kijelolve', () => {
    expect(explorerScript("C:\\A b\\Bo's", false)).toContain(`Start-Process explorer.exe -ArgumentList '"C:\\A b\\Bo''s"'`)
    expect(explorerScript('C:\\x\\f.md', true)).toContain(`-ArgumentList '/select,"C:\\x\\f.md"'`)
  })
})

describe('levetel / torles es mappa-gombok (felulet)', () => {
  const ITEM = { id: 'w1', title: 'Ajanlat', type: 'note', status: 'draft', current_version_id: 'v1', folder: 'Ajanlat', source_path: 'Projektek/Iroda/Ajanlat/terv.md' }
  const ASSETS = [
    { id: 'a1', name: 'terv.md', path: 'Projektek/Iroda/Ajanlat/terv.md', project_path: 'Ajanlat/terv.md', support: 'readable', present: true },
    { id: 'a2', name: 'logo.png', path: 'Projektek/Iroda/Ajanlat/logo.png', project_path: 'Ajanlat/logo.png', support: 'usable', present: true },
    { id: 'a3', name: 'x.exe', path: 'Projektek/Iroda/Ajanlat/x.exe', project_path: 'Ajanlat/x.exe', support: 'unsupported', present: true },
  ]
  const VERSIONS = [{ id: 'v1', version_no: 1, created_at: 1 }]

  function setup(fm = 'windows') {
    const h = workbenchHarness()
    const project = { id: 'p1', name: 'Iroda', archived: false }
    h.respond((url, init) => {
      if (url.includes('/api/workbench/file-manager')) return { status: 200, body: { kind: fm } }
      if (url.includes('/api/workbench/open-folder')) return { status: 200, body: { ok: true, path: 'Projektek/Iroda/Ajanlat', project: { id: 'p1', name: 'Iroda' } } }
      if (url.includes('/assets/') && init && init.method === 'DELETE') return { status: 200, body: { ok: true, assets: ASSETS.slice(1) } }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: VERSIONS, parts: [], assets: ASSETS } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    return h
  }
  async function opened(h: ReturnType<typeof workbenchHarness>) {
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-assets-block'))
  }
  const deletes = (h: ReturnType<typeof workbenchHarness>) => h.fetchCalls.filter((c) => c.init && c.init.method === 'DELETE').map((c) => c.url)

  it('a gomb neve Levetel / Torles, es kerdes jon (ablak nelkul): csak levetel, vegleges torles, megse', async () => {
    const h = setup()
    await opened(h)
    expect(h.html()).toContain('workbench.assets.remove')
    h.click({ 'data-wb-act': 'asset-remove', 'data-wb-asset': 'a1' })
    const html = h.html()
    expect(html).toContain('wb-warn-box')
    expect(html).toContain('workbench.assets.remove_ask')
    expect(html).toContain('data-wb-act="asset-unlink" data-wb-asset="a1"')
    expect(html).toContain('data-wb-act="asset-delete-file" data-wb-asset="a1"')
    expect(html).toContain('data-wb-act="warn-cancel"')
    expect(deletes(h)).toEqual([])
    h.click({ 'data-wb-act': 'warn-cancel' })
    expect(h.html()).not.toContain('workbench.assets.remove_ask')
    expect(deletes(h)).toEqual([])
  })

  it('csak levetel: sima DELETE; vegleges torles: `file=1`', async () => {
    const h = setup()
    await opened(h)
    h.click({ 'data-wb-act': 'asset-remove', 'data-wb-asset': 'a1' })
    h.click({ 'data-wb-act': 'asset-unlink', 'data-wb-asset': 'a1' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.assets.removed'))
    expect(deletes(h)[0]).not.toContain('file=1')
    h.click({ 'data-wb-act': 'asset-remove', 'data-wb-asset': 'a2' })
    h.click({ 'data-wb-act': 'asset-delete-file', 'data-wb-asset': 'a2' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.assets.deleted'))
    expect(deletes(h)[1]).toContain('/assets/a2?file=1')
  })

  it('csak a gondot jelzo cimke marad', async () => {
    const h = setup()
    await opened(h)
    const html = h.html()
    expect(html).not.toContain('workbench.assets.support.readable')
    expect(html).not.toContain('workbench.assets.support.usable')
    expect(html).toContain('workbench.assets.support.unsupported')
  })

  it('mappa-gombok: Anyagok + Verziok fejlec es minden anyag-sor; Intezo es Windows fajlkezelo', async () => {
    const h = setup()
    await opened(h)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="folder-system"'))
    const html = h.html()
    expect(html).toContain('data-wb-act="folder-intezo" data-wb-place="assets"')
    expect(html).toContain('data-wb-act="folder-intezo" data-wb-place="versions"')
    for (const id of ['a1', 'a2', 'a3']) expect(html).toContain(`data-wb-act="folder-system" data-wb-place="asset" data-wb-asset="${id}"`)
    expect(html).toContain('workbench.folder.system.windows')
  })

  it('fajlkezelo nelkuli gepen csak az Intezo gomb latszik', async () => {
    const h = setup('none')
    await opened(h)
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/file-manager'))).toBe(true))
    expect(h.html()).toContain('data-wb-act="folder-intezo"')
    expect(h.html()).not.toContain('data-wb-act="folder-system"')
  })

  it('Intezo gomb: az Intezoben nyitja meg a mappat; a masik a gepen', async () => {
    const h = setup()
    const openFiles = vi.fn()
    h.win._prjOpenFiles = openFiles
    await opened(h)
    h.click({ 'data-wb-act': 'folder-intezo', 'data-wb-place': 'asset', 'data-wb-asset': 'a2' })
    await vi.waitFor(() => expect(openFiles).toHaveBeenCalled())
    expect(openFiles.mock.calls[0][0]).toEqual({ id: 'p1', name: 'Iroda', folder_path: 'Projektek/Iroda/Ajanlat' })
    const body = JSON.parse(String(h.fetchCalls.find((c) => c.url.includes('/open-folder'))?.init?.body))
    expect(body).toEqual({ project: 'p1', place: 'asset', app: 'intezo', item: 'w1', asset: 'a2' })
    h.click({ 'data-wb-act': 'folder-system', 'data-wb-place': 'shared' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.folder.system_done'))
    const sys = h.fetchCalls.filter((c) => c.url.includes('/open-folder')).map((c) => JSON.parse(String(c.init?.body)))
    expect(sys[1]).toEqual({ project: 'p1', place: 'shared', app: 'system' })
  })
})
