// #893: the asset list of a work item costs a few 9p calls per row; 160+ rows in one synchronous pass froze the dashboard
// (/api/perf/stalls: listWorkItemAssets > resolveLifePath > realpathSync). The pass must give the loop back between rows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { attachAsset, listWorkItemAssets, listWorkItemAssetsSteps, listWorkItemAssetsSyncedYielding } from '../workbench-assets.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

describe('#893: the asset list yields between rows', () => {
  let depot = ''
  let itemId = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-asset-yield-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Ajanlat', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    for (const n of ['a.md', 'b.md', 'c.md']) { const r = attachAsset(w.item, n, Buffer.from(n)); if (!r.ok) throw new Error('anyag') }
  })
  afterEach(() => { rmSync(depot, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  it('the stepping generator yields once per row and returns the same list as the sync call', () => {
    const it = listWorkItemAssetsSteps(itemId)
    let yields = 0
    let r = it.next()
    while (!r.done) { yields++; r = it.next() }
    expect(yields).toBe(3)
    expect(r.value.map((a) => a.name)).toEqual(listWorkItemAssets(itemId).map((a) => a.name))
    expect(r.value.every((a) => a.present)).toBe(true)
  })

  it('the yielding list and the GET routes answer the same rows', async () => {
    const list = await listWorkItemAssetsSyncedYielding(itemId)
    expect(list).toHaveLength(3)
    const g = await callWorkbench(`/api/workbench/items/${itemId}/assets`, 'GET')
    expect(g.status).toBe(200)
    expect(g.body.assets.map((a: { name: string }) => a.name).sort()).toEqual(['a.md', 'b.md', 'c.md'])
    const one = await callWorkbench(`/api/workbench/items/${itemId}`, 'GET')
    expect(one.status).toBe(200)
    expect(one.body.assets).toHaveLength(3)
  })
})
