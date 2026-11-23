// #985: registering / linking ONE asset must not re-measure every other asset of the item on the disk. The old code listed
// the whole item (resolveLifePath + statSync per row, all synchronous) just to read back the row it had written: with 160+
// rows each attached file froze the dashboard loop for seconds (measured in /api/perf/stalls: 22 s with project-file-link).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const counter = vi.hoisted(() => ({ stats: 0 }))
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, statSync: ((...a: unknown[]) => { counter.stats++; return (real.statSync as (...x: unknown[]) => unknown)(...a) }) as typeof real.statSync }
})
const mountStore = vi.hoisted(() => require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'marveen-985-store-')) as string)
vi.mock('../config.js', async () => ({ ...(await vi.importActual<typeof import('../config.js')>('../config.js')), STORE_DIR: mountStore }))

import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { registerAsset, listWorkItemAssets, workItemAssetView } from '../workbench-assets.js'

describe('#985: one asset row, not the whole list', () => {
  let depot = ''
  let itemId = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-985-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda 985' })
    if (!p.ok) throw new Error('projekt')
    const up = updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    if (!up.ok) throw new Error('mappa')
    const it = createWorkItem({ project_id: p.project.id, type: 'document', title: 'Anyagos' })
    if (!it.ok) throw new Error('munkadarab')
    itemId = it.item.id
  })

  it('registering the 41st asset costs a constant number of stats, not 41', () => {
    const dir = join(depot, 'Projektek', 'Iroda')
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(dir, `f${i}.txt`), 'x' + i)
      registerAsset(itemId, `Projektek/Iroda/f${i}.txt`, `f${i}.txt`, 'sha' + i, 2, null)
    }
    writeFileSync(join(dir, 'last.txt'), 'last')
    counter.stats = 0
    const v = registerAsset(itemId, 'Projektek/Iroda/last.txt', 'last.txt', 'shalast', 4, null)
    expect(v.name).toBe('last.txt')
    expect(v.present).toBe(true)
    // the list still answers the same for every row; only the register path stopped re-measuring all of them
    expect(counter.stats).toBeLessThan(10)
    counter.stats = 0
    expect(listWorkItemAssets(itemId)).toHaveLength(41)
    expect(counter.stats).toBeGreaterThanOrEqual(41)
  })

  it('workItemAssetView answers one live row and nothing for a removed or foreign id', () => {
    writeFileSync(join(depot, 'Projektek', 'Iroda', 'a.txt'), 'a')
    const v = registerAsset(itemId, 'Projektek/Iroda/a.txt', 'a.txt', 'sha', 1, null)
    expect(workItemAssetView(itemId, v.id)?.present).toBe(true)
    expect(workItemAssetView(itemId, 'nincs-ilyen')).toBeUndefined()
    expect(workItemAssetView('masik', v.id)).toBeUndefined()
  })
})
