// #441 (v4 spec K-0.19): a projekt KOZOS TARA. A logo, a markaelemek egyszer
// vannak meg a projektben ("Kozos anyagok" mappa), es a munkadarabhoz csak
// HIVATKOZASKENT kerulnek -- masolat nem keszul, a levetel a fajlt nem erinti.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, setProjectArchived, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import {
  projectSharedFolder, listSharedFiles, uploadSharedFile, linkSharedAsset, listWorkItemAssets,
  attachAsset, unlinkAsset, renameWorkItemFolder, adoptExistingFolder,
} from '../workbench-assets.js'
import { getWorkItem } from '../workbench.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { buildContext } from '../workbench-agent/context.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

describe('a projekt kozos tara', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-shared-'))
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

  function newItem(title: string) {
    const w = createWorkItem({ project_id: pid, title, type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    return w.item
  }

  it('amig nincs, nem hozunk letre mappat csak azert, mert valaki megnezte', async () => {
    const r = await callWorkbench(`/api/workbench/shared?project=${pid}`, 'GET')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ folder: null, files: [] })
    expect(readdirSync(projDir())).toEqual([])
  })

  it('az elso feltoltes letrehozza a "Közös anyagok" mappat; angol feluletrol "Shared materials"', async () => {
    const r = await callWorkbench(`/api/workbench/shared?project=${pid}&name=logo.png`, 'POST', Buffer.from('PNG'))
    expect(r.status).toBe(201)
    expect(r.body.folder).toBe('Közös anyagok')
    expect(r.body.file).toMatchObject({ name: 'logo.png', support: 'usable', project_path: 'Közös anyagok/logo.png', used_by: 0 })
    expect(existsSync(join(projDir(), 'Közös anyagok', 'logo.png'))).toBe(true)

    initDatabase(':memory:')
    const p2 = createProject({ name: 'Masik' })
    if (!p2.ok) throw new Error('projekt')
    mkdirSync(join(depot, 'Masik'))
    updateProject(p2.project.id, { folder_path: 'Masik' })
    const en = uploadSharedFile(getProject(p2.project.id)!, 'logo.png', Buffer.from('PNG'), { lang: 'en' })
    expect(en.ok && en.folder).toBe('Shared materials')
  })

  it('egy mar letezo, kezzel csinalt "Közös anyagok" mappat felismer; egy MUNKADARAB ilyen nevu mappajat nem veszi at', () => {
    // A regi, meg nem koltoztetett munkadarab-mappa a projekt gyokerben all.
    const item = newItem('Közös anyagok')
    mkdirSync(join(depot, 'Projektek', 'Iroda', 'Közös anyagok'))
    writeFileSync(join(depot, 'Projektek', 'Iroda', 'Közös anyagok', 'sajat.md'), 'MUNKADARABE')
    expect(adoptExistingFolder(item, project, 'Közös anyagok').ok).toBe(true)
    expect(getWorkItem(item.id)?.folder).toBe('Közös anyagok')
    expect(projectSharedFolder(project).ok).toBe(false)
    const up = uploadSharedFile(project, 'logo.png', Buffer.from('PNG'))
    expect(up.ok && up.folder).toBe('Közös anyagok (2)')
    // ...es ezt jegyzi meg, akkor is, ha kozben a nev szabadda valna.
    expect(listSharedFiles(project).files.map((f) => f.name)).toEqual(['logo.png'])
  })

  it('ugyanaz a tartalom masodszorra 409 a meglevo nevevel; `force=1`-gyel mehet, felulirni SOSE ir', async () => {
    await callWorkbench(`/api/workbench/shared?project=${pid}&name=logo.png`, 'POST', Buffer.from('PNG'))
    const dup = await callWorkbench(`/api/workbench/shared?project=${pid}&name=logo2.png`, 'POST', Buffer.from('PNG'))
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('shared_duplicate')
    expect(dup.body.existing.name).toBe('logo.png')
    expect(dup.body.message).toMatch(/közös tár/)
    const forced = await callWorkbench(`/api/workbench/shared?project=${pid}&name=logo.png&force=1`, 'POST', Buffer.from('PNG'))
    expect(forced.status).toBe(201)
    expect(forced.body.renamed).toBe(true)
    expect(forced.body.files).toHaveLength(2)
  })

  it('futtathato fajl nem kerulhet be; archivalt projektbe nem lehet feltolteni; ismeretlen projekt 404', async () => {
    const exe = await callWorkbench(`/api/workbench/shared?project=${pid}&name=x.exe`, 'POST', Buffer.from('MZ'))
    expect(exe.status).toBe(400)
    expect(exe.body.error).toBe('asset_unsupported')
    expect((await callWorkbench('/api/workbench/shared?project=nincs', 'GET')).status).toBe(404)
    setProjectArchived(pid, true)
    expect((await callWorkbench(`/api/workbench/shared?project=${pid}&name=a.png`, 'POST', Buffer.from('x'))).status).toBe(409)
  })

  it('HIVATKOZAS, nem masolat: ket munkadarab ugyanarra a fajlra mutat; a levetel a fajlt nem erinti', async () => {
    uploadSharedFile(project, 'logo.png', Buffer.from('PNG'))
    const a = newItem('Poszt A')
    const b = newItem('Poszt B')
    const ra = await callWorkbench(`/api/workbench/items/${a.id}/assets/link`, 'POST', { path: 'Közös anyagok/logo.png' })
    expect(ra.status).toBe(201)
    expect(ra.body.asset).toMatchObject({ name: 'logo.png', shared: true, path: 'Projektek/Iroda/Közös anyagok/logo.png' })
    const rb = await callWorkbench(`/api/workbench/items/${b.id}/assets/link`, 'POST', { path: 'logo.png' })
    expect(rb.status).toBe(201)
    // Masolat nem keszult: a munkadarabok mappaja sem jott letre.
    expect(readdirSync(projDir())).toEqual(['Közös anyagok'])
    expect(readdirSync(join(projDir(), 'Közös anyagok'))).toEqual(['logo.png'])
    expect(listSharedFiles(project).files[0].used_by).toBe(2)
    // Masodszor: nem lesz duplan a listan.
    const again = await callWorkbench(`/api/workbench/items/${a.id}/assets/link`, 'POST', { path: 'logo.png' })
    expect(again.status).toBe(200)
    expect(again.body.already).toBe(true)
    expect(listWorkItemAssets(a.id)).toHaveLength(1)
    // Levetel: a fajl a kozos tarban marad.
    expect(unlinkAsset(a.id, ra.body.asset.id)).toBe(true)
    expect(existsSync(join(projDir(), 'Közös anyagok', 'logo.png'))).toBe(true)
  })

  it('csak a kozos tar fajlja kotheto be hivatkozaskent (mas mappa, kiszokes, hianyzo fajl: nem)', async () => {
    uploadSharedFile(project, 'logo.png', Buffer.from('PNG'))
    const item = newItem('Poszt')
    writeFileSync(join(projDir(), 'titok.md'), 'x')
    expect(linkSharedAsset(item, 'titok.md')).toEqual({ ok: false, code: 'not_found' })
    expect(linkSharedAsset(item, '../titok.md')).toEqual({ ok: false, code: 'not_shared' })
    expect(linkSharedAsset(item, 'Projektek/Iroda/titok.md')).toEqual({ ok: false, code: 'not_shared' })
    expect(linkSharedAsset(item, 'nincs.png')).toEqual({ ok: false, code: 'not_found' })
    const r = await callWorkbench(`/api/workbench/items/${item.id}/assets/link`, 'POST', { path: '../titok.md' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('not_shared')
    expect(listWorkItemAssets(item.id)).toEqual([])
  })

  it('a munkadarab atnevezese a kozos tarat nem viszi magaval, a hivatkozas ervenyes marad', () => {
    uploadSharedFile(project, 'logo.png', Buffer.from('PNG'))
    const item = newItem('Poszt')
    attachAsset(item, 'szoveg.md', Buffer.from('# x'))
    linkSharedAsset(item, 'logo.png')
    const r = renameWorkItemFolder(getWorkItem(item.id)!, 'Poszt uj')
    expect(r).toMatchObject({ ok: true, renamed: true, to: 'Munkadarabok/Poszt uj' })
    const assets = listWorkItemAssets(item.id)
    expect(assets.find((x) => x.name === 'logo.png')).toMatchObject({ path: 'Projektek/Iroda/Közös anyagok/logo.png', present: true, shared: true })
    expect(assets.find((x) => x.name === 'szoveg.md')).toMatchObject({ project_path: 'Munkadarabok/Poszt uj/szoveg.md', shared: false })
  })

  it('az agent: project.listShared (olvaso, szabad) es workItem.linkShared (iro, kategoriaval); a kontextus jeloli', () => {
    uploadSharedFile(project, 'logo.png', Buffer.from('PNG'))
    const item = newItem('Poszt')
    expect(getTool('project.listShared')?.autonomyCategory).toBe(null)
    expect(getTool('workItem.linkShared')?.autonomyCategory).toBe('marveen_selfdev')
    const ctx = { projectId: pid, workItemId: item.id, lang: 'hu' as const }
    const l = executeTool('project.listShared', {}, ctx)
    expect(l.ok && l.data).toMatchObject({ folder: 'Közös anyagok', count: 1, files: [{ path: 'Közös anyagok/logo.png', support: 'usable' }] })
    const k = executeTool('workItem.linkShared', { path: 'logo.png' }, ctx)
    expect(k.ok && k.data).toEqual({ linked: 'Közös anyagok/logo.png', already: false })
    const bad = executeTool('workItem.linkShared', { path: 'nincs/masik.png' }, ctx)
    expect(bad.ok).toBe(false)
    const c = buildContext(project, getWorkItem(item.id) ?? null, 'hu')
    expect(c.contextText).toContain('Közös anyagok/logo.png [usable, shared')
  })
})

describe('a felulet: Kozos tar az Anyagok dobozban', () => {
  const ITEM = { id: 'w1', title: 'Poszt', type: 'note', status: 'draft', current_version_id: 'v1', folder: 'Poszt', source_path: null }
  const LOGO = 'Projektek/Iroda/Közös anyagok/logo.png'

  function setup() {
    const h = workbenchHarness()
    const project = { id: 'p1', name: 'Iroda', archived: false }
    let linked = false
    const assets = () => (linked ? [{ id: 'a1', name: 'logo.png', path: LOGO, project_path: 'Közös anyagok/logo.png', support: 'usable', present: true, shared: true }] : [])
    h.respond((url, init) => {
      const post = !!init && init.method === 'POST'
      if (url.includes('/api/workbench/shared')) {
        if (post) return { status: 201, body: { ok: true, folder: 'Közös anyagok', files: [] } }
        return { status: 200, body: { folder: 'Közös anyagok', files: [
          { name: 'logo.png', path: LOGO, project_path: 'Közös anyagok/logo.png', support: 'usable', bytes: 3, used_by: 0 },
          { name: 'szinek.md', path: 'Projektek/Iroda/Közös anyagok/szinek.md', project_path: 'Közös anyagok/szinek.md', support: 'readable', bytes: 3, used_by: 0 },
        ] } }
      }
      if (url.includes('/assets/link') && post) { linked = true; return { status: 201, body: { ok: true, already: false, asset: { name: 'logo.png' }, assets: assets() } } }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: assets() } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    return h
  }

  it('a gombra megnyilik a kozos tar, egy fajl hivatkozaskent bekerul, es az anyagok kozott "kozos tarbol" jelolest kap', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="shared-toggle"'))
    expect(h.html()).not.toContain('wb-shared-block')
    h.click({ 'data-wb-act': 'shared-toggle' })
    await vi.waitFor(() => expect(h.html()).toContain('szinek.md'))
    expect(h.html()).toMatch(/<input type="file" id="wbSharedUpload"[^>]*multiple/)
    h.click({ 'data-wb-act': 'shared-link', 'data-wb-path': LOGO })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.shared.link_done'))
    const call = h.fetchCalls.find((c) => c.url.includes('/items/w1/assets/link'))
    expect(JSON.parse(String(call?.init?.body))).toEqual({ path: LOGO })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.shared.pill'))
    expect(h.html()).toContain('workbench.shared.linked')
  })

  it('a kozos tarba feltoltott fajl a /shared vegpontra megy, nem a munkadarab anyagai koze', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="shared-toggle"'))
    h.click({ 'data-wb-act': 'shared-toggle' })
    await vi.waitFor(() => expect(h.html()).toContain('wbSharedUpload'))
    h.change('wbSharedUpload', [{ name: 'uj logo.png', type: 'image/png', size: 3 }])
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.shared.upload_done'))
    const posts = h.fetchCalls.filter((c) => c.init && c.init.method === 'POST').map((c) => c.url)
    expect(posts.some((u) => u.startsWith('/api/workbench/shared?project=p1&name=uj%20logo.png'))).toBe(true)
    expect(posts.some((u) => u.includes('/items/w1/assets'))).toBe(false)
  })
})
