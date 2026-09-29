// #441 (v4 spec 0. fazis, K-0.9 ... K-0.18): a munkadarab SAJAT mappaja es
// ANYAGAI. Boss (2026-09-28): "hogy ne egy masik munkadarabot nyisson", es
// "irodan belul letre kellett volna hozni egy mappat hogy xy munkadarab".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, setProjectArchived, type ProjectRow } from '../projects.js'
import { createWorkItem, createWorkItemVersion, getWorkItem, listWorkItems, listWorkItemVersions } from '../workbench.js'
import {
  assetSupport, folderNameFromTitle, attachAsset, listWorkItemAssets, tidyWorkItemIntoFolder,
  listWorkItemAssetsSynced, renameWorkItemFolder, adoptExistingFolder, registerAsset,
  migrateAllWorkItemFolders, projectWorkItemsFolder,
} from '../workbench-assets.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { buildContext } from '../workbench-agent/context.js'
import { buildCodeBridgePrompt } from '../workbench-agent/code-bridge-turn.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

describe('tamogatasi allapot es mappanev', () => {
  it('K-0.15: fajtankent kimondja, mit tud vele az agent', () => {
    expect(assetSupport('terv.md')).toBe('readable')
    expect(assetSupport('jegyzet.txt')).toBe('readable')
    expect(assetSupport('logo.png')).toBe('usable')
    expect(assetSupport('level.pdf')).toBe('readable')
    expect(assetSupport('szerzodes.docx')).toBe('readable')
    expect(assetSupport('klip.mp4')).toBe('usable')
    expect(assetSupport('diktalas.wav')).toBe('needs_processor')
    expect(assetSupport('telepito.exe')).toBe('unsupported')
    expect(assetSupport('script.ps1')).toBe('unsupported')
  })

  it('a munkadarab nevebol Windows alatt is ervenyes mappanev lesz', () => {
    expect(folderNameFromTitle('Marvin Workbench terv')).toBe('Marvin Workbench terv')
    expect(folderNameFromTitle('Ajánlat: Kovács / 2026?')).not.toMatch(/[:/?]/)
    expect(folderNameFromTitle('vege pont.')).toBe('vege pont')
    expect(folderNameFromTitle('   ')).toBe('Munkadarab')
    expect(folderNameFromTitle('x'.repeat(300)).length).toBeLessThanOrEqual(80)
  })
})

describe('anyagok egy MEGLEVO munkadarabhoz', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-assets-'))
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

  function newItem(title = 'Marvin Workbench terv') {
    const w = createWorkItem({ project_id: pid, title, type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    return w.item
  }

  it('K-0.9/K-0.16: az elso fajl a munkadarab nevevel keszult SAJAT mappaba kerul, NEM lesz uj munkadarab', async () => {
    const item = newItem()
    const r = await callWorkbench(`/api/workbench/items/${item.id}/assets?name=${encodeURIComponent('valasz.md')}`, 'POST', Buffer.from('# Valasz'))
    expect(r.status).toBe(201)
    expect(r.body.folder).toBe('Munkadarabok/Marvin Workbench terv')
    expect(r.body.folder_created).toBe(true)
    expect(r.body.asset.support).toBe('readable')
    expect(r.body.asset.project_path).toBe('Munkadarabok/Marvin Workbench terv/valasz.md')
    expect(readFileSync(join(projDir(), 'Munkadarabok', 'Marvin Workbench terv', 'valasz.md'), 'utf-8')).toBe('# Valasz')
    expect(listWorkItems(pid)).toHaveLength(1)
    expect(getWorkItem(item.id)?.folder).toBe('Munkadarabok/Marvin Workbench terv')
  })

  it('K-0.15: tobb fajl egymas utan ugyanabba a mappaba; a lista a GET-ben is ott van, allapottal', async () => {
    const item = newItem()
    for (const [n, b] of [['logo.png', 'PNG'], ['level.pdf', '%PDF'], ['hang.wav', 'RIFF']] as const) {
      const r = await callWorkbench(`/api/workbench/items/${item.id}/assets?name=${n}`, 'POST', Buffer.from(b))
      expect(r.status).toBe(201)
    }
    const d = await callWorkbench(`/api/workbench/items/${item.id}`, 'GET')
    expect(d.body.assets.map((a: { name: string; support: string }) => `${a.name}:${a.support}`))
      .toEqual(['logo.png:usable', 'level.pdf:readable', 'hang.wav:needs_processor'])
    expect(d.body.assets.every((a: { present: boolean }) => a.present)).toBe(true)
  })

  it('K-0.18: ugyanaz a tartalom masodszorra 409 + a meglevo neve; `force=1`-gyel mehet, es SOSE ir felul', async () => {
    const item = newItem()
    await callWorkbench(`/api/workbench/items/${item.id}/assets?name=a.md`, 'POST', Buffer.from('UGYANAZ'))
    const dup = await callWorkbench(`/api/workbench/items/${item.id}/assets?name=b.md`, 'POST', Buffer.from('UGYANAZ'))
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('asset_duplicate')
    expect(dup.body.existing.name).toBe('a.md')
    expect(dup.body.message).toMatch(/már megvan/)
    const forced = await callWorkbench(`/api/workbench/items/${item.id}/assets?name=a.md&force=1`, 'POST', Buffer.from('UGYANAZ'))
    expect(forced.status).toBe(201)
    expect(forced.body.renamed).toBe(true)
    expect(listWorkItemAssets(item.id)).toHaveLength(2)
  })

  it('futtathato fajl nem lehet anyag; ures, archivalt: kulon ertheto valasz', async () => {
    const item = newItem()
    const exe = await callWorkbench(`/api/workbench/items/${item.id}/assets?name=x.exe`, 'POST', Buffer.from('MZ'))
    expect(exe.status).toBe(400)
    expect(exe.body.error).toBe('asset_unsupported')
    expect(existsSync(join(projDir(), 'Marvin Workbench terv'))).toBe(false)
    const empty = await callWorkbench(`/api/workbench/items/${item.id}/assets?name=a.md`, 'POST', Buffer.alloc(0))
    expect(empty.body.error).toBe('upload_empty')
    setProjectArchived(pid, true)
    const arch = await callWorkbench(`/api/workbench/items/${item.id}/assets?name=a.md`, 'POST', Buffer.from('x'))
    expect(arch.status).toBe(409)
  })

  it('a mappanev foglalt (pl. a felhasznalo sajat mappaja): `nev (2)` lesz, a meglevobe nem ir', () => {
    mkdirSync(join(projDir(), 'Munkadarabok', 'Marvin Workbench terv'), { recursive: true })
    writeFileSync(join(projDir(), 'Munkadarabok', 'Marvin Workbench terv', 'sajat.txt'), 'SAJAT')
    const item = newItem()
    const r = attachAsset(item, 'uj.md', Buffer.from('UJ'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.folder).toBe('Munkadarabok/Marvin Workbench terv (2)')
    expect(readFileSync(join(projDir(), 'Munkadarabok', 'Marvin Workbench terv', 'sajat.txt'), 'utf-8')).toBe('SAJAT')
  })

  it('levetel a listarol: a FAJL a mappaban marad', async () => {
    const item = newItem()
    const up = await callWorkbench(`/api/workbench/items/${item.id}/assets?name=a.md`, 'POST', Buffer.from('A'))
    const del = await callWorkbench(`/api/workbench/items/${item.id}/assets/${up.body.asset.id}`, 'DELETE')
    expect(del.status).toBe(200)
    expect(del.body.assets).toHaveLength(0)
    expect(existsSync(join(projDir(), 'Munkadarabok', 'Marvin Workbench terv', 'a.md'))).toBe(true)
    expect((await callWorkbench(`/api/workbench/items/${item.id}/assets/${up.body.asset.id}`, 'DELETE')).status).toBe(404)
  })

  describe('K-0.12 rendrakas: az omlesztett fo fajl a sajat mappaba', () => {
    it('a munkadarab ES a verzioi az uj helyre mutatnak; a fajl tartalma ugyanaz', async () => {
      writeFileSync(join(projDir(), 'terv.md'), 'TERV')
      const w = createWorkItem({ project_id: pid, title: 'Marvin Workbench implementacios terv', type: 'note', source_path: 'Projektek/Iroda/terv.md' })
      if (!w.ok) throw new Error('mw')
      createWorkItemVersion(w.item.id, { source_path: 'Projektek/Iroda/terv.md' })
      const r = await callWorkbench(`/api/workbench/items/${w.item.id}/tidy`, 'POST', {})
      expect(r.status).toBe(200)
      const to = 'Projektek/Iroda/Munkadarabok/Marvin Workbench implementacios terv/terv.md'
      expect(r.body.moved).toEqual([{ from: 'Projektek/Iroda/terv.md', to }])
      expect(getWorkItem(w.item.id)?.source_path).toBe(to)
      expect(listWorkItemVersions(w.item.id).every((v) => v.source_path === to)).toBe(true)
      expect(existsSync(join(projDir(), 'terv.md'))).toBe(false)
      expect(readFileSync(join(projDir(), 'Munkadarabok', 'Marvin Workbench implementacios terv', 'terv.md'), 'utf-8')).toBe('TERV')
      expect(listWorkItemAssets(w.item.id).map((a) => a.path)).toEqual([to])
    })

    it('egy MEGLEVO mappa is kijelolheto (a tulajdonos kezzel csinalt mappaja)', () => {
      mkdirSync(join(projDir(), 'Marvin Workbench terv'))
      writeFileSync(join(projDir(), 'terv.md'), 'TERV')
      const w = createWorkItem({ project_id: pid, title: 'Marvin Workbench implementacios terv', type: 'note', source_path: 'Projektek/Iroda/terv.md' })
      if (!w.ok) throw new Error('mw')
      const r = tidyWorkItemIntoFolder(w.item, { folder: 'Marvin Workbench terv' })
      expect(r.ok).toBe(true)
      expect(getWorkItem(w.item.id)?.folder).toBe('Marvin Workbench terv')
      expect(getWorkItem(w.item.id)?.source_path).toBe('Projektek/Iroda/Marvin Workbench terv/terv.md')
      // Masik munkadarab ugyanezt a mappat nem veheti at.
      const other = newItem('Masik')
      const r2 = tidyWorkItemIntoFolder(other, { folder: 'Marvin Workbench terv' })
      expect(r2.ok).toBe(false)
      if (!r2.ok) expect(r2.code).toBe('folder_taken')
    })

    it('a MASIK munkadarab altal is hasznalt fajlhoz nem nyul (kimondja, miert)', () => {
      writeFileSync(join(projDir(), 'kozos.md'), 'K')
      const a = createWorkItem({ project_id: pid, title: 'A', type: 'note', source_path: 'Projektek/Iroda/kozos.md' })
      const b = createWorkItem({ project_id: pid, title: 'B', type: 'note', source_path: 'Projektek/Iroda/kozos.md' })
      if (!a.ok || !b.ok) throw new Error('mw')
      const r = tidyWorkItemIntoFolder(a.item)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.moved).toEqual([])
        expect(r.skipped).toEqual([{ path: 'Projektek/Iroda/kozos.md', reason: 'shared' }])
      }
      expect(existsSync(join(projDir(), 'kozos.md'))).toBe(true)
      expect(getWorkItem(b.item.id)?.source_path).toBe('Projektek/Iroda/kozos.md')
    })
  })

  describe('0/b: a mappa es a lista osszhangja', () => {
    it('a mappaba kezzel tett fajlok maguktol megjelennek az anyagok kozott (rejtett / futtathato kimarad)', async () => {
      const item = newItem()
      attachAsset(item, 'elso.md', Buffer.from('1'))
      const dir = join(projDir(), 'Munkadarabok', 'Marvin Workbench terv')
      writeFileSync(join(dir, 'v2.md'), '2')
      writeFileSync(join(dir, 'v3.md'), '3')
      writeFileSync(join(dir, 'desktop.ini'), 'x')
      writeFileSync(join(dir, 'x.exe'), 'MZ')
      mkdirSync(join(dir, 'alma'))
      const names = listWorkItemAssetsSynced(item.id).map((a) => a.name)
      expect(names).toEqual(['elso.md', 'v2.md', 'v3.md'])
      // Masodszorra nem duplaz.
      expect(listWorkItemAssetsSynced(item.id)).toHaveLength(3)
      const d = await callWorkbench(`/api/workbench/items/${item.id}`, 'GET')
      expect(d.body.assets).toHaveLength(3)
    })

    it('K-0.11: atnevezeskor a mappa is atnevezodik, es MINDEN hivatkozas az uj helyre mutat', () => {
      const item = newItem('Regi nev')
      const r0 = attachAsset(item, 'a.md', Buffer.from('A'))
      if (!r0.ok) throw new Error('attach')
      const src = 'Projektek/Iroda/Munkadarabok/Regi nev/a.md'
      createWorkItemVersion(item.id, { source_path: src })
      const r = executeTool('workItem.update', { id: item.id, title: 'Uj nev' }, { projectId: pid, workItemId: item.id, lang: 'hu' })
      expect(r.ok).toBe(true)
      if (r.ok) expect((r.data as { folder_rename: unknown }).folder_rename).toEqual({ ok: true, renamed: true, from: 'Munkadarabok/Regi nev', to: 'Munkadarabok/Uj nev' })
      const after = getWorkItem(item.id)
      expect(after?.folder).toBe('Munkadarabok/Uj nev')
      expect(after?.source_path).toBe('Projektek/Iroda/Munkadarabok/Uj nev/a.md')
      expect(listWorkItemAssets(item.id)[0].path).toBe('Projektek/Iroda/Munkadarabok/Uj nev/a.md')
      expect(readFileSync(join(projDir(), 'Munkadarabok', 'Uj nev', 'a.md'), 'utf-8')).toBe('A')
      expect(existsSync(join(projDir(), 'Munkadarabok', 'Regi nev'))).toBe(false)
    })

    it('K-0.11: a felulet atnevezes-vegpontja: uj nev + mappa, ures nev elutasitva', async () => {
      const item = newItem('Regi')
      attachAsset(item, 'a.md', Buffer.from('A'))
      const bad = await callWorkbench(`/api/workbench/items/${item.id}/rename`, 'POST', { title: '  ' })
      expect(bad.status).toBe(400)
      const r = await callWorkbench(`/api/workbench/items/${item.id}/rename`, 'POST', { title: 'Friss' })
      expect(r.status).toBe(200)
      expect(r.body.item.title).toBe('Friss')
      expect(r.body.folder_rename).toEqual({ ok: true, renamed: true, from: 'Munkadarabok/Regi', to: 'Munkadarabok/Friss' })
      expect(existsSync(join(projDir(), 'Munkadarabok', 'Friss', 'a.md'))).toBe(true)
    })

    it('K-0.11: foglalt uj nev -> `nev (2)`; masik munkadarab altal hivatkozott vagy rajzot tarto mappa marad (megmondja, miert)', () => {
      mkdirSync(join(projDir(), 'Munkadarabok', 'Uj nev'), { recursive: true })
      const a = newItem('A nev')
      attachAsset(a, 'a.md', Buffer.from('A'))
      const r = renameWorkItemFolder(getWorkItem(a.id)!, 'Uj nev')
      expect(r).toEqual({ ok: true, renamed: true, from: 'Munkadarabok/A nev', to: 'Munkadarabok/Uj nev (2)' })

      const b = newItem('B nev')
      attachAsset(b, 'b.md', Buffer.from('B'))
      createWorkItem({ project_id: pid, title: 'Kulso', type: 'note', source_path: 'Projektek/Iroda/Munkadarabok/B nev/b.md' })
      expect(renameWorkItemFolder(getWorkItem(b.id)!, 'Masik')).toEqual({ ok: true, renamed: false, reason: 'shared' })

      const c = newItem('C nev')
      attachAsset(c, 'rajz.canvas.json', Buffer.from('{}'))
      expect(renameWorkItemFolder(getWorkItem(c.id)!, 'Rajz uj')).toEqual({ ok: true, renamed: false, reason: 'canvas' })
      expect(existsSync(join(projDir(), 'Munkadarabok', 'C nev'))).toBe(true)
    })
  })

  describe('K-0.17: az agent LATJA az anyagokat, es tudja, mit olvashat', () => {
    it('workItem.listAssets: ut (projekt-relativ, file.read-hez), allapot; olvasasi eszkoz, szabad', () => {
      const item = newItem()
      attachAsset(item, 'valasz.md', Buffer.from('# V'))
      attachAsset(item, 'logo.png', Buffer.from('PNG'))
      const tool = getTool('workItem.listAssets')
      expect(tool?.destructive).toBe(false)
      expect(tool?.autonomyCategory).toBe(null)
      const r = executeTool('workItem.listAssets', {}, { projectId: pid, workItemId: item.id, lang: 'hu' })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const data = r.data as { folder: string; assets: { path: string; support: string }[] }
      expect(data.folder).toBe('Munkadarabok/Marvin Workbench terv')
      expect(data.assets).toEqual([
        expect.objectContaining({ path: 'Munkadarabok/Marvin Workbench terv/valasz.md', support: 'readable' }),
        expect.objectContaining({ path: 'Munkadarabok/Marvin Workbench terv/logo.png', support: 'usable' }),
      ])
      // ...es a kapott uttal a file.read tenyleg olvas.
      const read = executeTool('file.read', { path: data.assets[0].path }, { projectId: pid, workItemId: item.id, lang: 'hu' })
      expect(read.ok).toBe(true)
      if (read.ok) expect((read.data as { text: string }).text).toContain('# V')
    })

    it('a projekt-asszisztens kontextusa es a teljes ugynok promptja is felsorolja az anyagokat', () => {
      const item = newItem()
      attachAsset(item, 'valasz.md', Buffer.from('# V'))
      const c = buildContext(project, getWorkItem(item.id) ?? null, 'hu')
      expect(c.contextText).toContain('folder: Munkadarabok/Marvin Workbench terv')
      expect(c.contextText).toContain('Munkadarabok/Marvin Workbench terv/valasz.md [readable]')
      const prompt = buildCodeBridgePrompt({
        projectName: 'Iroda', projectFolder: '/x', history: [], message: 'olvasd el', lang: 'hu',
        workItem: { title: 'Marvin Workbench terv', type: 'note', folder: 'Marvin Workbench terv', materials: ['Marvin Workbench terv/valasz.md [readable]'] },
      })
      expect(prompt).toContain('Work item folder (inside the project folder): Marvin Workbench terv')
      expect(prompt).toContain('Marvin Workbench terv/valasz.md [readable]')
    })
  })
})

describe('Munkadarabok mappa (1A, 2A): minden projektnek van, a regi munkadarab-mappak alaköltoznek', () => {
  let depot = ''
  let pid = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-box-'))
    mkdirSync(projDir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('projektmappa')
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('2A: az indulaskori sopres uresen is elkesziti a Munkadarabok mappat, es masodszorra nem csinal semmit', () => {
    const first = migrateAllWorkItemFolders()
    expect(first).toEqual({ projects: 1, moved: 0, skipped: 0 })
    expect(existsSync(join(projDir(), 'Munkadarabok'))).toBe(true)
    expect(migrateAllWorkItemFolders()).toEqual({ projects: 1, moved: 0, skipped: 0 })
  })

  it('1A: a projekt gyokerben allo munkadarab-mappa alakerul, a nyilvantartas (munkadarab, verzio, anyag) vele megy, a fajl ugyanaz', () => {
    const w = createWorkItem({ project_id: pid, title: 'Marvin Workbench terv', type: 'note' })
    if (!w.ok) throw new Error('mw')
    mkdirSync(join(projDir(), 'Marvin Workbench terv'))
    writeFileSync(join(projDir(), 'Marvin Workbench terv', 'terv.md'), 'TERV')
    const src = 'Projektek/Iroda/Marvin Workbench terv/terv.md'
    const item = getWorkItem(w.item.id)!
    adoptExistingFolder(item, getProject(pid) as ProjectRow, 'Marvin Workbench terv')
    registerAsset(item.id, src, 'terv.md', 'sha', 4, null)
    createWorkItemVersion(item.id, { source_path: src })

    expect(migrateAllWorkItemFolders()).toEqual({ projects: 1, moved: 1, skipped: 0 })
    const to = 'Projektek/Iroda/Munkadarabok/Marvin Workbench terv/terv.md'
    expect(getWorkItem(item.id)?.folder).toBe('Munkadarabok/Marvin Workbench terv')
    const withFile = listWorkItemVersions(item.id).filter((v) => v.source_path)
    expect(withFile.length).toBeGreaterThan(0)
    expect(withFile.every((v) => v.source_path === to)).toBe(true)
    expect(listWorkItemAssets(item.id).map((a) => a.path)).toEqual([to])
    expect(readFileSync(join(projDir(), 'Munkadarabok', 'Marvin Workbench terv', 'terv.md'), 'utf-8')).toBe('TERV')
    expect(existsSync(join(projDir(), 'Marvin Workbench terv'))).toBe(false)
    // Masodszorra nincs mit mozgatni.
    expect(migrateAllWorkItemFolders()).toEqual({ projects: 1, moved: 0, skipped: 0 })
  })

  it('a masik munkadarab altal hivatkozott vagy rajzot tarto mappa marad, es a szamlalo megmondja', () => {
    const a = createWorkItem({ project_id: pid, title: 'Rajzos', type: 'note' })
    if (!a.ok) throw new Error('mw')
    mkdirSync(join(projDir(), 'Rajzos'))
    writeFileSync(join(projDir(), 'Rajzos', 'r.canvas.json'), '{}')
    adoptExistingFolder(getWorkItem(a.item.id)!, getProject(pid) as ProjectRow, 'Rajzos')
    expect(migrateAllWorkItemFolders()).toEqual({ projects: 1, moved: 0, skipped: 1 })
    expect(existsSync(join(projDir(), 'Rajzos', 'r.canvas.json'))).toBe(true)
  })

  it('egy angol nevu, mar meglevo "Work items" mappat atvesz, nem csinal mellette masodikat', () => {
    mkdirSync(join(projDir(), 'Work items'))
    const box = projectWorkItemsFolder(getProject(pid) as ProjectRow)
    expect(box.ok && box.folder).toBe('Work items')
    expect(existsSync(join(projDir(), 'Munkadarabok'))).toBe(false)
  })
})

describe('a felulet: Anyagok doboz es a chat 📎 gombja', () => {
  const ITEM = { id: 'w1', title: 'Marvin Workbench terv', type: 'note', status: 'draft', current_version_id: 'v1', folder: 'Marvin Workbench terv', source_path: 'Projektek/Iroda/terv.md' }
  const ASSETS = [
    { id: 'a1', name: 'valasz.md', path: 'Projektek/Iroda/Marvin Workbench terv/valasz.md', project_path: 'Marvin Workbench terv/valasz.md', support: 'readable', present: true },
    { id: 'a2', name: 'hang.wav', path: 'Projektek/Iroda/Marvin Workbench terv/hang.wav', project_path: 'Marvin Workbench terv/hang.wav', support: 'needs_processor', present: false },
  ]

  function setup(opts: { dupOnce?: boolean } = {}) {
    const h = workbenchHarness()
    const project = { id: 'p1', name: 'Iroda', archived: false }
    let dupLeft = opts.dupOnce ? 1 : 0
    h.respond((url, init) => {
      if (url.includes('/assets') && init && init.method === 'POST') {
        if (dupLeft > 0 && !url.includes('force=1')) {
          dupLeft--
          return { status: 409, body: { error: 'asset_duplicate', message: 'már megvan', existing: { name: 'regi.png' } } }
        }
        return { status: 201, body: { ok: true, asset: { id: 'a9' }, assets: ASSETS } }
      }
      if (url.includes('/tidy')) return { status: 200, body: { ok: true, folder: 'Marvin Workbench terv', moved: [{ from: 'x', to: 'y' }], skipped: [] } }
      if (url.includes('/api/workbench/agent/message')) return { status: 200, body: 'event: done\ndata: {"type":"done"}\n\n' }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: ASSETS } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    return h
  }
  const file = (name: string, type = '') => ({ name, type, size: 3 })
  const posts = (h: ReturnType<typeof workbenchHarness>) => h.fetchCalls.filter((c) => c.init && c.init.method === 'POST').map((c) => c.url)

  it('a megnyitott munkadarabnal ott az Anyagok doboz (mappa, lista allapottal, tobbfajlos feltolto, huzasi zona) es a chat 📎', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-assets-block'))
    const html = h.html()
    expect(html).toContain('workbench.assets.title')
    expect(html).toContain('valasz.md')
    // Csak a gondot jelzo cimke marad (Boss, 2026-09-29, 1888): az "olvashato"
    // felesleges, a "feldolgozo kell hozza" mond valamit.
    expect(html).not.toContain('workbench.assets.support.readable')
    expect(html).toContain('workbench.assets.support.needs_processor')
    expect(html).toContain('workbench.assets.missing')
    expect(html).toMatch(/<input type="file" id="wbAssetUpload"[^>]*multiple/)
    expect(html).toMatch(/<input type="file" id="wbChatAssetUpload"[^>]*multiple/)
    expect(html).toContain('data-wb-drop="assets"')
    // A fo fajl meg omlesztve all: felajanljuk a rendrakast.
    expect(html).toContain('data-wb-act="asset-tidy"')
  })

  it('a 📎-val valasztott fajlok az ANYAGOK koze mennek, nem lesz belolük uj munkadarab', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wbChatAssetUpload'))
    h.change('wbChatAssetUpload', [file('logo.png', 'image/png'), file('level.pdf')])
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.assets.done'))
    const p = posts(h)
    expect(p.filter((u) => u.includes('/items/w1/assets'))).toHaveLength(2)
    expect(p.some((u) => u.includes('/items/upload'))).toBe(false)
    expect(p.some((u) => u.includes('/parts/image'))).toBe(false)
  })

  // Boss, 2026-09-29: "csatoltam ket mellekletet, nem tortent semmi, nem tudom
  // hol van" -- a feltoltes sikerult, de a chatben semmi nem latszott.
  it('a csatolt fajlok a chatben, a beiro mezo felett latszanak, es a kovetkezo uzenettel az agens is megkapja oket', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wbChatAssetUpload'))
    h.change('wbChatAssetUpload', [file('Passbild.png', 'image/png'), file('20260922_181305.jpg', 'image/jpeg')])
    // Feltoltes kozben a chatben latszik az allapot.
    expect(h.html()).toContain('workbench.chat.attached_uploading')
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.assets.done'))
    const html = h.html()
    expect(html).toMatch(/class="wb-attached-chip">📎 Passbild\.png/)
    expect(html).toMatch(/class="wb-attached-chip">📎 20260922_181305\.jpg/)
    expect(html).toContain('workbench.chat.attached_hint')
    expect(html).toContain('data-wb-act="assets-show"')
    // Szoveg nelkul is elkuldheto; a nevek az uzenetben mennek.
    h.click({ 'data-wb-act': 'chat-send' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/agent/message'))).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/api/workbench/agent/message'))
    const body = JSON.parse(String(call?.init?.body))
    expect(body.work_item_id).toBe('w1')
    expect(body.message).toContain('workbench.chat.attached_line')
    expect(body.message).toContain('Passbild.png, 20260922_181305.jpg')
    // Elkuldes utan a sor eltunik -- a fajlok az Anyagok kozott maradnak.
    await vi.waitFor(() => expect(h.html()).not.toContain('wb-attached-chip'))
  })

  it('a csatolt fajlt ki lehet hagyni az uzenetbol (a fajl az anyagok kozott marad); szoveggel egyutt a szoveg utan jon', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wbChatAssetUpload'))
    h.change('wbChatAssetUpload', [file('egy.pdf'), file('ketto.pdf')])
    await vi.waitFor(() => expect(h.html()).toContain('📎 ketto.pdf'))
    h.click({ 'data-wb-act': 'chat-attached-drop', 'data-wb-attached': '0' })
    expect(h.html()).not.toContain('📎 egy.pdf')
    expect(h.fetchCalls.some((c) => c.init && c.init.method === 'DELETE')).toBe(false)
    h.inputs.wbChatInput = { value: 'nezd meg', focus() {} }
    h.click({ 'data-wb-act': 'chat-send' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/agent/message'))).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/api/workbench/agent/message'))
    const message = JSON.parse(String(call?.init?.body)).message as string
    expect(message.startsWith('nezd meg\n\n')).toBe(true)
    expect(message).toContain('ketto.pdf')
    expect(message).not.toContain('egy.pdf')
  })

  it('csatolt fajl nelkul ures uzenet nem megy el', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wbChatAssetUpload'))
    expect(h.html()).not.toContain('wb-attached')
    h.click({ 'data-wb-act': 'chat-send' })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/agent/message'))).toBe(false)
  })

  it('ugyanaz a tartalom: megkerdezi, es igennel `force=1`-gyel ujrakuldi', async () => {
    const h = setup({ dupOnce: true })
    ;(h.win as unknown as { confirm: () => boolean }).confirm = () => true
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wbAssetUpload'))
    h.change('wbAssetUpload', [file('logo.png', 'image/png')])
    await vi.waitFor(() => expect(posts(h).some((u) => u.includes('/assets') && u.includes('force=1'))).toBe(true))
  })

  it('atnevezes gomb: uj nevet ker, a rename vegpontot hivja', async () => {
    const h = setup()
    ;(h.win as unknown as { prompt: () => string }).prompt = () => 'Uj nev'
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="item-rename"'))
    h.click({ 'data-wb-act': 'item-rename' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/items/w1/rename') && c.init && c.init.method === 'POST')).toBe(true))
  })

  it('minden sajat szoveg a t()-n megy at', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-assets-block'))
    expect(untranslatedHungarian(h.html(), ['Iroda', 'Marvin Workbench terv', 'valasz.md', 'hang.wav'])).toBe('')
  })
})
