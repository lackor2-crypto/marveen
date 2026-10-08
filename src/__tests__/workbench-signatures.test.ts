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
const { listSignatures } = await import('../workbench-signatures.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) throw new Error('not on the temp depot')

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Emberek', 'Nagymama'), { recursive: true })
  mkdirSync(join(root, 'Emberek', 'Laszlo', 'identitas'), { recursive: true })
})

describe('listSignatures', () => {
  it('collects signature pictures from the whole tree and ignores other files', () => {
    writeFileSync(join(root, 'Emberek', 'Nagymama', 'alairas.png'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'identitas', 'Aláírás Laszlo.PNG'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'identitas', 'signature.txt'), 'x')
    writeFileSync(join(root, 'Emberek', 'Laszlo', 'utlevel.png'), 'x')
    const r = listSignatures('hu')
    expect(r.signatures.map((s) => s.name).sort()).toEqual(['Aláírás Laszlo.PNG', 'alairas.png'])
    expect(r.signatures.every((s) => s.rel.endsWith(s.name) && s.folder.startsWith('Emberek'))).toBe(true)
  })

  it('returns an empty list when there is none', () => {
    expect(listSignatures('hu').signatures).toEqual([])
  })
})
