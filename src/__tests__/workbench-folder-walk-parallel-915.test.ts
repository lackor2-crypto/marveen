import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #915 (Boss TG 6118, "a projekteknel a bal oldali mappa oszlop nehezen toelt be"): the depot lives on a 9p drive where
// every fs call costs ~7 ms, and the folder walk of GET /api/workbench/items asked the drive one thing at a time
// (readdir per folder, statSync per file, existsSync('.git') per folder): 3.5-6.4 s for 113 folders / 129 files.
// The stepping protocol now (a) answers the stats of one folder concurrently, (b) reads sub-folders ahead.

const fake = vi.hoisted(() => {
  const state = { statActive: 0, statMax: 0, dirActive: 0, dirMax: 0, delay: 15 }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  return { state, sleep }
})

vi.mock('node:fs/promises', () => ({
  stat: async () => {
    const s = fake.state
    s.statActive++; s.statMax = Math.max(s.statMax, s.statActive)
    await fake.sleep(s.delay)
    s.statActive--
    return { size: 1, birthtimeMs: 1, mtimeMs: 1 }
  },
  readdir: async (dir: string) => {
    const s = fake.state
    s.dirActive++; s.dirMax = Math.max(s.dirMax, s.dirActive)
    await fake.sleep(s.delay)
    s.dirActive--
    const d = (name: string) => ({ name, isDirectory: () => true, isFile: () => false })
    if (dir === '/root') return [d('a'), d('b'), d('c'), d('d'), d('e'), d('f')]
    return []
  },
}))

import { drainStepsYielding, type Steps } from '../yielding.js'

beforeEach(() => { Object.assign(fake.state, { statActive: 0, statMax: 0, dirActive: 0, dirMax: 0 }) })

describe('the stepping drain asks a slow drive for several things at once (#915)', () => {
  it('answers the stats of one folder concurrently', async () => {
    const into = new Map<string, unknown>()
    const gen = function* (): Steps<number> {
      yield { stat: ['/x/1', '/x/2', '/x/3', '/x/4', '/x/5', '/x/6'], into: into as never }
      return into.size
    }
    expect(await drainStepsYielding(gen())).toBe(6)
    expect(fake.state.statMax).toBeGreaterThan(1)
  })

  it('reads the sub-folders of a listed folder ahead', async () => {
    const gen = function* (): Steps<number> {
      yield { readdir: '/root' }
      // the walk asks for the children only now: they must already be in flight together
      yield { readdir: '/root/a' }
      return 1
    }
    await drainStepsYielding(gen())
    expect(fake.state.dirMax).toBeGreaterThan(1)
  })
})

describe('the Workbench folder walk does not ask the drive serially (#915)', () => {
  const src = readFileSync(join(__dirname, '..', 'workbench-assets.ts'), 'utf8')
  const a = src.indexOf('function* listWorkFoldersSteps(')
  const rest = src.slice(a + 10)
  const m = /\nexport function |\nfunction\*? /.exec(rest)
  const body = rest.slice(0, m ? m.index : rest.length)

  it('has no statSync per file (one stat step per folder)', () => {
    expect(a).toBeGreaterThan(-1)
    expect(body).not.toMatch(/statSync\(/)
    expect(body).toContain('stat: take.map')
  })

  it('finds a repository from the listing it already read, not one existsSync per folder', () => {
    // the only remaining existsSync('.git') is the depth-limit guard, where the child is not read at all
    const hits = body.match(/existsSync\(join\(childAbs, '\.git'\)\)/g) ?? []
    expect(hits.length).toBe(1)
    expect(body).toMatch(/depth \+ 1 > WORK_FOLDER_MAX_DEPTH && existsSync/)
    expect(body).toContain("e.name === '.git'")
  })
})
