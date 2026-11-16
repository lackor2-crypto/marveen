import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WORK_FOLDERS_FRESH_MS, _resetListingCache, _stopDepotWriteEpoch, bumpDepotEpoch, listingCacheStats, sharedListing, startDepotWriteEpoch,
} from '../web/work-folders-cache.js'

const ROOT = path.join(__dirname, '..', '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

beforeEach(() => _resetListingCache())
afterEach(() => _stopDepotWriteEpoch())

function counter<T>(value: T, delayMs = 0) {
  const state = { calls: 0 }
  const compute = async () => { state.calls++; if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return value }
  return { state, compute }
}

describe('#929 the Workbench tree listing is computed once and shared', () => {
  it('asks the disk once for repeated polls within the fresh window', async () => {
    const c = counter({ folders: ['a'] })
    let t = 1000
    const now = () => t
    const a = await sharedListing('p1', c.compute, { now })
    t += 9_000
    const b = await sharedListing('p1', c.compute, { now })
    expect(c.state.calls).toBe(1)
    expect(b).toBe(a)
    expect(listingCacheStats().hits).toBe(1)
  })

  it('asks the disk again once the fresh window is over (a change made outside the program shows up)', async () => {
    const c = counter(1)
    let t = 1000
    const now = () => t
    await sharedListing('p1', c.compute, { now })
    t += WORK_FOLDERS_FRESH_MS + 1
    await sharedListing('p1', c.compute, { now })
    expect(c.state.calls).toBe(2)
  })

  it('keeps projects apart', async () => {
    const c = counter(1)
    await sharedListing('p1', c.compute)
    await sharedListing('p2', c.compute)
    expect(c.state.calls).toBe(2)
  })

  it('lets pages that ask at the same time share the one computation that is running', async () => {
    const c = counter('x', 30)
    const all = await Promise.all([sharedListing('p1', c.compute), sharedListing('p1', c.compute), sharedListing('p1', c.compute)])
    expect(c.state.calls).toBe(1)
    expect(all).toEqual(['x', 'x', 'x'])
    expect(listingCacheStats().joined).toBe(2)
  })

  it('forgets the answer at once when something may have changed', async () => {
    const c = counter(1)
    await sharedListing('p1', c.compute)
    bumpDepotEpoch()
    await sharedListing('p1', c.compute)
    expect(c.state.calls).toBe(2)
  })

  it('does not remember a listing that was read while a change landed, and does not hand it to a later asker', async () => {
    const c = counter(1, 30)
    const first = sharedListing('p1', c.compute)
    bumpDepotEpoch() // a write lands while the disk is being read
    const second = sharedListing('p1', c.compute) // must NOT join the older computation
    await Promise.all([first, second])
    expect(c.state.calls).toBe(2)
    await sharedListing('p1', c.compute)
    expect(c.state.calls).toBe(2) // the second one was remembered
  })

  it('bypass (an assistant turn is running) reads the disk again even inside the fresh window', async () => {
    const c = counter(1)
    await sharedListing('p1', c.compute)
    await sharedListing('p1', c.compute, { bypass: true })
    expect(c.state.calls).toBe(2)
    expect(listingCacheStats().bypassed).toBe(1)
  })

  it('does not remember a failure', async () => {
    let n = 0
    const compute = async () => { n++; if (n === 1) throw new Error('drive gone'); return 'ok' }
    await expect(sharedListing('p1', compute)).rejects.toThrow('drive gone')
    expect(await sharedListing('p1', compute)).toBe('ok')
    expect(n).toBe(2)
  })
})

describe('#929 the program\'s own writes under the depot make the remembered listing old', () => {
  it('a synchronous write under the depot bumps the epoch, one elsewhere does not', () => {
    const depot = fs.mkdtempSync(path.join(os.tmpdir(), 'depot929-'))
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other929-'))
    try {
      startDepotWriteEpoch(() => depot)
      const e0 = listingCacheStats().epoch
      fs.writeFileSync(path.join(other, 'a.txt'), 'x')
      expect(listingCacheStats().epoch).toBe(e0)
      fs.writeFileSync(path.join(depot, 'a.txt'), 'x')
      expect(listingCacheStats().epoch).toBeGreaterThan(e0)
      const e1 = listingCacheStats().epoch
      fs.renameSync(path.join(other, 'a.txt'), path.join(depot, 'b.txt')) // moved INTO the depot
      expect(listingCacheStats().epoch).toBeGreaterThan(e1)
      expect(fs.readFileSync(path.join(depot, 'b.txt'), 'utf8')).toBe('x') // the call itself is untouched
    } finally {
      _stopDepotWriteEpoch()
      fs.rmSync(depot, { recursive: true, force: true })
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('a sync write call keeps its error behaviour', () => {
    const depot = fs.mkdtempSync(path.join(os.tmpdir(), 'depot929-'))
    try {
      startDepotWriteEpoch(() => depot)
      expect(() => fs.unlinkSync(path.join(depot, 'missing'))).toThrow(/ENOENT/)
    } finally {
      _stopDepotWriteEpoch()
      fs.rmSync(depot, { recursive: true, force: true })
    }
  })
})

describe('#929 the wiring (source contract)', () => {
  it('GET /api/workbench/items asks for the folder listing through the shared cache, fresh while a turn runs', () => {
    const src = read('src/web/routes/workbench.ts')
    expect(src).toMatch(/work_folders: await sharedListing\('folders:' \+ project\.id, \(\) => listWorkFoldersYielding\(project\), \{ bypass: anyTurnRunning\(\) \}\)/)
  })
  it('every request that can change something forgets the listing, at its start and its end', () => {
    const src = read('src/web.ts')
    expect(src).toMatch(/method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'\) \{ bumpDepotEpoch\(\); res\.once\('close', bumpDepotEpoch\) \}/)
    expect(src).toMatch(/startDepotWriteEpoch\(explorerRoot\)/)
  })
})
