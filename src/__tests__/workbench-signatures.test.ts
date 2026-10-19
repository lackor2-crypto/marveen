import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-sign-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-sign-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

// The disk lists a folder in whatever order it likes; the walk's fairness is about ORDER, so make it one fixed order
// (alphabetical: "Archívum" before "Család", the bad case).
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readdir: (async (...a: Parameters<typeof actual.readdir>) => {
      const list = await (actual.readdir as (...x: unknown[]) => Promise<Array<{ name: string }>>)(...a)
      return [...list].sort((x, y) => String(x.name).localeCompare(String(y.name)))
    }) as typeof actual.readdir,
  }
})

const { explorerRoot } = await import('../life-explorer.js')
const { listSignatures, forgetSignatures } = await import('../workbench-signatures.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) throw new Error('not on the temp depot')

beforeEach(() => {
  forgetSignatures()
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Emberek', 'Nagymama'), { recursive: true })
  mkdirSync(join(root, 'Emberek', 'Laszlo', 'identitas'), { recursive: true })
})

describe('listSignatures', () => {
  it('finds a .webp signature in the identity folder (owner TG 3783: "anyu alairasa.webp")', async () => {
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'identitas', 'anyu alairasa.webp'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'identitas', 'alairas scan.bmp'), 'x')
    const r = await listSignatures('hu')
    expect(r.signatures.map((s) => s.name).sort()).toEqual(['alairas scan.bmp', 'anyu alairasa.webp'])
  })

  it('collects signature pictures from the whole tree and ignores other files', async () => {
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'identitas', 'Aláírás Laszlo.PNG'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'identitas', 'signature.txt'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'utlevel.png'), 'x')
    const r = await listSignatures('hu')
    expect(r.signatures.map((s) => s.name).sort()).toEqual(['Aláírás Laszlo.PNG', 'alairas.png'])
    expect(r.signatures.every((s) => s.rel.endsWith(s.name) && s.folder.startsWith('Emberek'))).toBe(true)
  })

  it('returns an empty list when there is none', async () => {
    expect((await listSignatures('hu')).signatures).toEqual([])
  })
})

describe('the walk never blocks and is not repeated (2026-10-10 freeze)', () => {
  it('the trash and dot folders are skipped; one answer is reused, a "fresh" call looks again', async () => {
    mkdirSync(join(root, 'Kuka'), { recursive: true })
    mkdirSync(join(root, 'Emberek', '.rejtett'), { recursive: true })
    writeFileSync(join(root, 'Emberek', '.rejtett', 'alairas.png'), 'x')
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    const a = await listSignatures('hu')
    expect(a.signatures.map((s) => s.rel)).toEqual(['Emberek/Nagymama/alairas.png'])
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'signature2.jpg'), 'x')
    expect(await listSignatures('hu')).toBe(a) // remembered: no second walk
    expect((await listSignatures('hu', { fresh: true })).signatures).toHaveLength(2)
  })

  it('two callers at the same time share one walk', async () => {
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    const [x, y] = await Promise.all([listSignatures('hu'), listSignatures('hu')])
    expect(x).toBe(y)
  })

  it('out of time: says so, returns what it has; the half answer is reused briefly, "fresh" looks again', async () => {
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    const half = await listSignatures('hu', { budgetMs: -1 })
    expect(half).toEqual({ signatures: [], truncated: true }) // "did not get to the end", not "there is none"
    expect(await listSignatures('hu')).toBe(half)
    const full = await listSignatures('hu', { fresh: true })
    expect(full.truncated).toBe(false)
    expect(full.signatures).toHaveLength(1)
  })

  it('a wide archive listed first does not starve the identity folder when the folder budget runs out', async () => {
    rmSync(join(root, 'Emberek'), { recursive: true, force: true }) // the shared fixture's folders would use up the budget
    // Archívum: 3 folders with 5 sub-folders each (15 folders on the level where the identity folder also is).
    for (const a of ['a1', 'a2', 'a3']) for (let i = 0; i < 5; i++) mkdirSync(join(root, 'Archívum', a, 'm' + i), { recursive: true })
    mkdirSync(join(root, 'Család', 'Laszlo', 'Identitás'), { recursive: true })
    writeFileSync(join(root, 'Család', 'Laszlo', 'Identitás', 'laszlo alairas.png'), 'x')
    writeFileSync(join(root, 'Archívum', 'a1', 'm0', 'regi alairas.png'), 'x')
    // 8 folders: root, Archívum, Család, a1, a2, a3, Laszlo -- then the 8th must be Identitás, not one of the 15.
    const r = await listSignatures('hu', { fresh: true, maxFolders: 8 })
    expect(r.signatures.map((s) => s.rel)).toEqual(['Család/Laszlo/Identitás/laszlo alairas.png'])
    expect(r.truncated).toBe(true) // and it still says the tree was not seen to the end
  })

  it('the module reads folders asynchronously and never calls the synchronous tree search', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(__dirname, '..', 'workbench-signatures.ts'), 'utf8')
    expect(src).toContain("from 'node:fs/promises'")
    expect(src).not.toMatch(/readdirSync|statSync|searchLife\(/)
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf8')
    expect(route).toContain('await listSignatures(lang')
  })
})
