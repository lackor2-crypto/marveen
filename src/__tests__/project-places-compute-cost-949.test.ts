import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({ resolve: 0, stat: 0 }))
const FOLDERS = ['Munkadarabok/A', 'Munkadarabok/B', 'Munkadarabok/C']
const assets = Array.from({ length: 200 }, (_, i) => ({ path: `${FOLDERS[i % 3]}/file-${i}.pdf` }))
const annexes = Array.from({ length: 60 }, (_, i) => ({ path: `${FOLDERS[i % 3]}/annex-${i}.pdf`, linked: false }))

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  statSync: (p: string) => { calls.stat++; return { isDirectory: () => !/\.[a-z]+$/i.test(String(p)) } },
}))
vi.mock('../life-explorer.js', () => ({ resolveLifePath: (rel: string) => { calls.resolve++; return '/life/' + rel } }))
vi.mock('../projects.js', () => ({ getProject: () => ({ folder_path: 'P' }) }))
vi.mock('../project-places.js', () => ({ listProjectPlaces: () => [] }))
vi.mock('../workbench-doc-links.js', () => ({ listProjectDocs: () => ({ docs: [], attachments: [] }) }))
vi.mock('../workbench-docannex.js', () => ({ listAnnexes: () => annexes }))
vi.mock('../workbench-assets.js', () => ({ ensureAssetTables: () => {}, findWorkItemsBox: () => '', PROJECT_ROOT_PLACE: '' }))
vi.mock('../db.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => (/work_item_assets/.test(sql) ? assets : [{ id: 'i1', title: 'Item', folder: null, container_folder: null, source_path: null }]),
      get: () => undefined,
    }),
  }),
}))

import { projectPlacesView, clearProjectPlacesCache } from '../project-places-auto.js'

// #949: after the 15 s memory ran out (or any write dropped it) one answer still asked the slow Windows mount
// two or three times PER FILE (a project with 223 materials = ~1000 stat/realpath calls = 10 s of frozen server).
describe('one computation of the places view asks the disk per FOLDER, not per file (#949)', () => {
  beforeEach(() => { clearProjectPlacesCache(); calls.resolve = 0; calls.stat = 0 })
  it('260 files in 3 folders cost a handful of disk calls', () => {
    const view = projectPlacesView('p1', { fresh: true })
    expect(calls.resolve).toBeLessThan(25)
    expect(calls.stat).toBeLessThan(25)
    // the answer is unchanged: the three folders, each with its files counted
    const rels = view.map((p) => p.rel).sort()
    expect(rels).toEqual(['P/Munkadarabok/A', 'P/Munkadarabok/B', 'P/Munkadarabok/C'])
  })
})
