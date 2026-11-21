// #953 (Boss TG 7144: "ez kurvasok lefagyas", 267.9 s): the Inbox analysis walked the whole Life tree with synchronous
// statSync/readdirSync on the main thread (walkKnownFolders, buildLearnedIndex). On the slow depot disk that held the
// dashboard for minutes. The server paths must use the awaited twins, which give the SAME answer and let the event loop
// run while the tree is read.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-walk953-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-walk953-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { explorerRoot } = await import('../life-explorer.js')
const A = await import('../life-inbox-analyze.js')
const { loadLifeConfig, saveLifeConfig } = await import('../life-tree.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) throw new Error('The test is not on the temporary depot -- not starting.')
const PERSON = 'Korpás László'

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Beérkező'), { recursive: true })
  saveLifeConfig({ persons: [{ id: 'p1', name: PERSON, role: 'owner', countries: [], mediaGroups: [] }], companies: [] } as any)
})

describe('awaited Life-tree walks (#953)', () => {
  it('buildKnownFoldersAsync finds the same folders as the synchronous walk, skipping hidden ones', async () => {
    mkdirSync(join(root, PERSON, 'Hatóságok', 'Németország', 'Jobcenter'), { recursive: true })
    mkdirSync(join(root, PERSON, 'Számlák'), { recursive: true })
    mkdirSync(join(root, PERSON, '.hidden', 'x'), { recursive: true })
    writeFileSync(join(root, PERSON, 'Számlák', 'file.txt'), 'x')
    const cfg = loadLifeConfig()
    const sync = A.buildKnownFolders(cfg)
    const asyncOut = await A.buildKnownFoldersAsync(cfg)
    expect(asyncOut.map((f) => f.rel).sort()).toEqual(sync.map((f) => f.rel).sort())
    expect(asyncOut.map((f) => f.rel)).toContain(`${PERSON}/Hatóságok/Németország/Jobcenter`)
    expect(asyncOut.some((f) => f.rel.includes('.hidden'))).toBe(false)
    expect(asyncOut.some((f) => f.rel.endsWith('file.txt'))).toBe(false)
  })

  it('buildLearnedIndexAsync learns the same tokens as the synchronous walk', async () => {
    mkdirSync(join(root, PERSON, 'Hatóságok'), { recursive: true })
    writeFileSync(join(root, PERSON, 'Hatóságok', 'hatosag_level_regi.pdf'), 'x')
    const cfg = loadLifeConfig()
    const sync = A.buildLearnedIndex(cfg)
    const asyncIdx = await A.buildLearnedIndexAsync(cfg)
    expect(asyncIdx.sampleCount).toBe(sync.sampleCount)
    expect(asyncIdx.sampleCount).toBeGreaterThan(0)
    expect([...asyncIdx.personTokens.keys()].sort()).toEqual([...sync.personTokens.keys()].sort())
    expect([...asyncIdx.categoryTokens.keys()].sort()).toEqual([...sync.categoryTokens.keys()].sort())
  })

  it('the event loop runs while a big tree is read (a timer fires before the walk ends)', async () => {
    for (let i = 0; i < 60; i++) mkdirSync(join(root, PERSON, `Mappa${i}`, 'al'), { recursive: true })
    const cfg = loadLifeConfig()
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 0)
    const out = await A.buildKnownFoldersAsync(cfg)
    clearInterval(timer)
    expect(out.length).toBeGreaterThanOrEqual(120)
    // The synchronous walk gives the timer no chance at all (0 ticks); the awaited one yields between directories.
    expect(ticks).toBeGreaterThan(5)
  })

  it('the server paths no longer call the synchronous walks', () => {
    const analyze = readFileSync(join(process.cwd(), 'src', 'life-inbox-analyze.ts'), 'utf8')
    const route = analyze.slice(analyze.indexOf('export async function analyzeInboxAsync'))
    expect(route).toContain('await buildLearnedIndexAsync(config)')
    expect(route).toContain('await buildKnownFoldersAsync(config, lang)')
    expect(route).not.toMatch(/[^c]buildLearnedIndex\(config\)/)
    const move = readFileSync(join(process.cwd(), 'src', 'workbench-life-move.ts'), 'utf8')
    expect(move).toContain('buildLearnedIndexAsync(config)')
    expect(move).not.toMatch(/\bbuildLearnedIndex\(/)
  })
})
