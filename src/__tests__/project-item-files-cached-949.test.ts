import { describe, it, expect, vi, beforeEach } from 'vitest'

const fsCalls = vi.hoisted(() => ({ readdir: 0, stat: 0 }))
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  readdirSync: () => { fsCalls.readdir++; return ['a.pdf', 'b.pdf'] },
  statSync: () => { fsCalls.stat++; return { isDirectory: () => false, isFile: () => true, size: 1, mtimeMs: 1000 } },
}))
vi.mock('../life-explorer.js', () => ({ resolveLifePath: (rel: string) => '/life/' + rel }))
vi.mock('../workbench-doc-links.js', () => ({ listProjectDocs: () => ({ docs: [], attachments: [] }) }))
vi.mock('../project-places-auto.js', () => ({ projectItemFolders: () => [{ item_id: 'i1', title: 'T', rel: 'P/A' }] }))

import { projectItemFilesCached, clearProjectItemFilesCache, ITEM_FILES_TTL_MS } from '../project-item-files.js'

// #949: the item-files list of the Documents panel stat-ed every file of every work item folder per answer
// (the other half of the main-thread freeze on the slow Windows mount).
describe('projectItemFilesCached remembers the list (#949)', () => {
  beforeEach(() => { clearProjectItemFilesCache(); fsCalls.readdir = 0; fsCalls.stat = 0 })
  it('a repeat within the TTL touches the disk zero times', () => {
    const t0 = 1_000_000
    expect(projectItemFilesCached('p1', { now: t0 }).files.length).toBe(2)
    const first = { ...fsCalls }
    expect(first.stat).toBeGreaterThan(0)
    projectItemFilesCached('p1', { now: t0 + 1000 })
    expect(fsCalls).toEqual(first)
  })
  it('after the TTL, when asked fresh, or after a write, it measures again', () => {
    const t0 = 1_000_000
    projectItemFilesCached('p1', { now: t0 })
    const first = fsCalls.stat
    projectItemFilesCached('p1', { now: t0 + ITEM_FILES_TTL_MS + 1 })
    expect(fsCalls.stat).toBe(first * 2)
    projectItemFilesCached('p1', { now: t0 + ITEM_FILES_TTL_MS + 2, fresh: true })
    expect(fsCalls.stat).toBe(first * 3)
    clearProjectItemFilesCache()
    projectItemFilesCached('p1', { now: t0 + ITEM_FILES_TTL_MS + 3 })
    expect(fsCalls.stat).toBe(first * 4)
  })
})
