// #716 (Boss TG 10015): a file uploaded into a work item's Uploads folder is put in its place in the Life tree; the
// work item keeps reaching it (the Uploads tile follows), and an annex that stood on the old place becomes a link.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder, attachAsset, listWorkItemAssets, projectRelative } from '../workbench-assets.js'
import { lifeMoveCandidates, moveItemFilesToLife, movedPairs } from '../workbench-life-move.js'
import { markSentManually } from '../workbench-docsent.js'
import { relinkMovedAnnexes } from '../workbench-doc-links.js'
import { ensureAnnexTables } from '../workbench-docannex.js'

describe('#716: feltoltes -> Eletfa', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  const annexRows = (itemId: string) => getDb().prepare('SELECT * FROM wb_doc_annexes WHERE work_item_id = ?').all(itemId) as Array<{ path: string; life_rel: string | null; title: string }>
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-upload-move-'))
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

  function setup() {
    const w = createWorkItem({ project_id: pid, title: 'AOK elutasitas', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('mappa')
    const dir = join(projDir(), f.folder)
    mkdirSync(join(dir, 'Feltöltések'), { recursive: true })
    writeFileSync(join(dir, 'Feltöltések', 'aok-level.jpg'), 'jpg-1')
    writeFileSync(join(dir, 'kesz.pdf'), 'k')
    return { item: getWorkItem(w.item.id) as any, dir }
  }

  it('a jelolt-lista modjai: alapbol nincs feltoltes, include = minden, only = csak a feltoltesek', () => {
    const { item } = setup()
    const names = (m: 'exclude' | 'include' | 'only') => {
      const c = lifeMoveCandidates(project, item, m)
      if (!c.ok) throw new Error('jeloltek')
      return c.files.map((x) => x.name).sort()
    }
    expect(names('exclude')).toEqual(['kesz.pdf'])
    expect(names('include')).toEqual(['aok-level.jpg', 'kesz.pdf'])
    expect(names('only')).toEqual(['aok-level.jpg'])
    const c = lifeMoveCandidates(project, item, 'only')
    if (!c.ok) throw new Error('jeloltek')
    expect(c.files[0].upload).toBe(true)
  })

  it('a feltoltesbol jovahagyott sor atkerul az Eletfaba, az uj helyre mutat az anyag (link), az alap mod pedig tovabbra sem engedi', () => {
    const { item, dir } = setup()
    const c = lifeMoveCandidates(project, item, 'only')
    if (!c.ok) throw new Error('jeloltek')
    const rel = c.files[0].rel
    mkdirSync(join(depot, 'Cel'), { recursive: true })
    // a default (exclude) mode refuses an upload row: it is not on that list
    const refused = moveItemFilesToLife(project, item, [{ rel, target: 'Cel' }], 'hu')
    if (!refused.ok) throw new Error('mozgatas')
    expect(refused.results[0].ok).toBe(false)
    expect(existsSync(join(dir, 'Feltöltések', 'aok-level.jpg'))).toBe(true)
    markSentManually(item.id, null) // only a sent document moves (the gate)
    const r = moveItemFilesToLife(project, item, [{ rel, target: 'Cel' }], 'hu', 'include')
    if (!r.ok) throw new Error('mozgatas')
    expect(r.results[0].ok).toBe(true)
    expect(existsSync(join(dir, 'Feltöltések', 'aok-level.jpg'))).toBe(false)
    expect(existsSync(join(depot, 'Cel', 'aok-level.jpg'))).toBe(true)
    expect(movedPairs(r.results)).toEqual([{ oldRel: rel, newRel: 'Cel/aok-level.jpg' }])
  })

  it('az anyag-sor (a Feltoltesek csempe) kovet: a fajl az Eletfaban van, a sor oda mutat', () => {
    const { item, dir } = setup()
    const up = attachAsset(item, 'level2.pdf', Buffer.from('pdf-2'), { createdBy: 'test', into: 'uploads' } as any)
    if (!up.ok) throw new Error('feltoltes: ' + JSON.stringify(up))
    const before = listWorkItemAssets(item.id).find((a) => a.name === 'level2.pdf')!
    mkdirSync(join(depot, 'Cel'), { recursive: true })
    markSentManually(item.id, null) // only a sent document moves (the gate)
    const r = moveItemFilesToLife(project, item, [{ rel: before.path, target: 'Cel' }], 'hu', 'include')
    if (!r.ok) throw new Error('mozgatas')
    expect(r.results[0].ok).toBe(true)
    const after = listWorkItemAssets(item.id).find((a) => a.name === 'level2.pdf')!
    expect(after.path).toBe('Cel/level2.pdf')
    expect(after.present).toBe(true)
    expect(existsSync(join(dir, 'Feltöltések', 'level2.pdf'))).toBe(false)
  })

  it('a feltoltes helyen allo melleklet LINK lesz az Eletfaba kerult fajlra (azonos sorszam, cim), mas projekt sora nem valtozik', async () => {
    const { item } = setup()
    ensureAnnexTables()
    const db = getDb()
    const c = lifeMoveCandidates(project, item, 'only')
    if (!c.ok) throw new Error('jeloltek')
    const oldRel = c.files[0].rel
    const projRel = projectRelative(project, oldRel)
    const ins = db.prepare('INSERT INTO wb_doc_annexes (id, work_item_id, position, path, title, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('a1', item.id, 0, projRel, 'AOK elutasito level', 1, 'test')
    // another project with the same relative path text must not be touched
    const p2 = createProject({ name: 'Masik' })
    if (!p2.ok) throw new Error('projekt2')
    const w2 = createWorkItem({ project_id: p2.project.id, title: 'Masik doc', type: 'note' })
    if (!w2.ok) throw new Error('munkadarab2')
    ins.run('a2', w2.item.id, 0, projRel, 'masik', 1, 'test')
    mkdirSync(join(depot, 'Cel'), { recursive: true })
    markSentManually(item.id, null) // only a sent document moves (the gate)
    const r = moveItemFilesToLife(project, item, [{ rel: oldRel, target: 'Cel' }], 'hu', 'include')
    if (!r.ok) throw new Error('mozgatas')
    expect(await relinkMovedAnnexes(project, movedPairs(r.results))).toBe(1)
    const rows = annexRows(item.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].path).toMatch(/^doc:DOC-/)
    expect(rows[0].life_rel).toBe('Cel/aok-level.jpg')
    expect(rows[0].title).toBe('AOK elutasito level')
    expect(annexRows(w2.item.id)[0].path).toBe(projRel)
  })
})

// #716: "Mellékletet CSAK az Életfából csatolunk." A file inside a work item's own folder is not an annex candidate.
import { annexNeedsLifeMove } from '../workbench-annex-guard.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { executeTool } from '../workbench-agent/execute.js'

describe('#716: a melleklet csak az Eletfabol', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  let itemId = ''
  let folder = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-annex-life-'))
    mkdirSync(join(projDir(), 'Iratok'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    project = getProject(pid) as ProjectRow
    const w = createWorkItem({ project_id: pid, title: 'Valaszbeadvany', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('mappa')
    folder = f.folder
    mkdirSync(join(projDir(), folder, 'Feltöltések'), { recursive: true })
    writeFileSync(join(projDir(), folder, 'Feltöltések', 'aok.jpg'), 'jpg')
    writeFileSync(join(projDir(), 'Iratok', 'szerzodes.pdf'), 'pdf')
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a munkadarab mappajan belul allo fajl nem mellekletjelolt, a projekt mas helyen allo igen', () => {
    expect(annexNeedsLifeMove(project, `${folder}/Feltöltések/aok.jpg`)).toBe(true)
    expect(annexNeedsLifeMove(project, `${folder}/kesz.pdf`)).toBe(true)
    expect(annexNeedsLifeMove(project, 'Iratok/szerzodes.pdf')).toBe(false)
    expect(annexNeedsLifeMove(project, '')).toBe(false)
  })

  it('az utvonal a feltoltesbeli fajlt 409-cel elutasitja, a projekt masik fajljat felveszi', async () => {
    const base = `/api/workbench/items/${itemId}/outline`
    const bad = await callWorkbench(`${base}/annexes`, 'POST', { path: `${folder}/Feltöltések/aok.jpg`, title: 'AOK' })
    expect(bad.status).toBe(409)
    expect(bad.body.error).toBe('outline_annex_not_in_life')
    expect(bad.body.message).toContain('Életfába')
    const ok = await callWorkbench(`${base}/annexes`, 'POST', { path: 'Iratok/szerzodes.pdf', title: 'Szerződés' })
    expect(ok.status).toBe(201)
  })

  it('az agent doc.addAnnex a feltoltesbeli fajlt not_in_life koddal utasitja el', () => {
    const ctx = { projectId: pid, workItemId: itemId, lang: 'hu' as const }
    const bad: any = executeTool('doc.addAnnex', { path: `${folder}/Feltöltések/aok.jpg`, title: 'AOK' }, ctx)
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('not_in_life')
    expect(executeTool('doc.addAnnex', { path: 'Iratok/szerzodes.pdf', title: 'Szerződés' }, ctx).ok).toBe(true)
  })

  it('a gepről csatolt melleklet a Feltoltesekbe kerul es MEG NEM melleklet: a felulet az Eletfaba koltoztetes utan koti be', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/outline/annexes/upload?name=${encodeURIComponent('levél.pdf')}`, 'POST', Buffer.from('%PDF-1'), { 'content-type': 'application/octet-stream' })
    expect(r.status).toBe(201)
    expect(r.body.needs_move).toBe(true)
    expect(r.body.rel).toContain('Feltöltések')
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM wb_doc_annexes WHERE work_item_id = ?').get(itemId) as { n: number }).n).toBe(0)
    expect(existsSync(join(depot, r.body.rel))).toBe(true)
  })
})
