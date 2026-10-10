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

  it('the module reads folders asynchronously and never calls the synchronous tree search', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(__dirname, '..', 'workbench-signatures.ts'), 'utf8')
    expect(src).toContain("from 'node:fs/promises'")
    expect(src).not.toMatch(/readdirSync|statSync|searchLife\(/)
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf8')
    expect(route).toContain('await listSignatures(lang')
  })
})
